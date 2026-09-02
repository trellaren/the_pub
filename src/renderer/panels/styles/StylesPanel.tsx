import { useState } from 'react'
import type { NamedStyle } from '@shared/model/style.js'
import type { ProjectFont } from '@shared/model/manifest.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import {
  PanelShell,
  PanelHeader,
  EmptyState,
  Select,
  TextInput,
  ToolbarButton,
  Field,
  NumberField,
  Checkbox,
  SectionTitle,
  cx
} from '@renderer/ui/primitives.js'
import { previewStyle } from '@renderer/panels/editor/extensions/namedStyles.js'
import { invoke, attempt, reportNotice } from '@renderer/lib/ipc.js'

/**
 * Faces that exist on the platforms this ships to, each with a fallback of the
 * right shape. Naming a font the machine does not have silently substitutes
 * something else, so the list stays to faces Windows and macOS both have, or
 * that degrade to a sibling rather than to a different kind of type.
 */
const FONTS = [
  'Georgia, serif',
  'Cambria, Georgia, serif',
  'Constantia, Georgia, serif',
  'Palatino Linotype, Palatino, serif',
  'Times New Roman, Times, serif',
  'Calibri, Helvetica, Arial, sans-serif',
  'Segoe UI, Helvetica, Arial, sans-serif',
  'Helvetica, Arial, sans-serif',
  'Consolas, Courier New, monospace',
  'Courier New, Courier, monospace'
]

/**
 * Style editor.
 *
 * Editing a style here changes every block using it across every open document
 * at once, because documents store the style id and the formatting is applied
 * through a generated stylesheet.
 */
export function StylesPanel() {
  const project = useProjectStore((store) => store.project)
  const updateManifest = useProjectStore((store) => store.updateManifest)
  const styles = project?.manifest.styles ?? []
  const fonts = project?.manifest.fonts ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = styles.find((style) => style.id === selectedId) ?? styles[0]

  const patch = (changes: Partial<NamedStyle>): void => {
    if (!selected) return
    void updateManifest((manifest) => ({
      ...manifest,
      styles: manifest.styles.map((style) =>
        style.id === selected.id ? { ...style, ...changes } : style
      )
    }))
  }

  const patchText = (changes: Partial<NamedStyle['text']>): void => {
    if (!selected) return
    patch({ text: { ...selected.text, ...changes } })
  }
  const patchParagraph = (changes: Partial<NamedStyle['paragraph']>): void => {
    if (!selected) return
    patch({ paragraph: { ...selected.paragraph, ...changes } })
  }

  const addStyle = (): void => {
    const id = `style-${Date.now().toString(36)}`
    void updateManifest((manifest) => ({
      ...manifest,
      styles: [
        ...manifest.styles,
        {
          id,
          name: 'New Style',
          builtin: false,
          basedOn: 'body',
          nextStyle: 'body',
          text: {},
          paragraph: {}
        }
      ]
    }))
    setSelectedId(id)
  }

  const importFont = async (): Promise<void> => {
    const result = await attempt(invoke('fonts:importDialog', {}), 'Could not import the font')
    // Null is the file dialog being cancelled, which is not a failure.
    if (!result) return
    await updateManifest((manifest) => ({ ...manifest, fonts: [...manifest.fonts, result.font] }))
  }

  const removeFont = async (font: ProjectFont): Promise<void> => {
    if (!window.confirm(`Remove ${font.family}? Text set in it falls back to another face.`)) return
    // The manifest entry goes first: a file that outlives its entry is dead
    // weight, but an entry that outlives its file is a font that renders as a
    // fallback with nothing in the panel explaining why.
    await updateManifest((manifest) => ({
      ...manifest,
      fonts: manifest.fonts.filter((candidate) => candidate.id !== font.id)
    }))
    await invoke('fonts:delete', { file: font.file }).catch(() => {})
  }

  const removeStyle = (): void => {
    if (!selected || selected.builtin) return
    void updateManifest((manifest) => ({
      ...manifest,
      styles: manifest.styles.filter((style) => style.id !== selected.id)
    }))
    setSelectedId(null)
  }

  const [preset, setPreset] = useState<'builtin-submission-times' | 'builtin-submission-courier'>(
    'builtin-submission-times'
  )

  /**
   * Writes a submission preset's styles and page setup over the project's own
   * — see `TemplateService.presetStylesAndPage`. Never touches a `.pubdoc`:
   * this only replaces `manifest.styles` and the three `project.page*`
   * settings, the same two things editing a style or the page setup panel by
   * hand already changes.
   */
  const applyPreset = async (): Promise<void> => {
    if (
      !window.confirm(
        'This replaces every style (fonts, sizes, spacing) and the page setup with the preset\'s. Prose content is untouched. Continue?'
      )
    ) {
      return
    }
    const result = await attempt(invoke('templates:applyPreset', { templateId: preset }), 'Could not apply the preset')
    if (!result) return
    await updateManifest((manifest) => ({
      ...manifest,
      styles: result.styles,
      settings: {
        ...manifest.settings,
        pageWidth: result.page.width,
        pageHeight: result.page.height,
        pageMarginTop: result.page.margins.top,
        pageMarginBottom: result.page.margins.bottom,
        pageMarginLeft: result.page.margins.left,
        pageMarginRight: result.page.margins.right
      }
    }))
    reportNotice('Preset applied.')
  }

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>Styles</PanelHeader>
        <EmptyState title="No project open" />
      </PanelShell>
    )
  }

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1">Styles</span>
        <ToolbarButton label="New style" onClick={addStyle}>
          ＋
        </ToolbarButton>
        <ToolbarButton label="Delete style" onClick={removeStyle} disabled={selected?.builtin ?? true}>
          ✕
        </ToolbarButton>
        <select
          aria-label="Submission preset"
          className="h-6 shrink-0 rounded border border-border bg-transparent px-1 text-[11px]"
          value={preset}
          onChange={(event) => setPreset(event.target.value as typeof preset)}
        >
          <option value="builtin-submission-times">Standard Manuscript (Times)</option>
          <option value="builtin-submission-courier">Standard Manuscript (Courier)</option>
        </select>
        <ToolbarButton label="Apply submission preset" onClick={() => void applyPreset()}>
          Apply preset
        </ToolbarButton>
      </PanelHeader>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ul className="w-32 shrink-0 overflow-auto border-r border-border py-1">
          {styles.map((style) => (
            <li key={style.id}>
              <button
                type="button"
                onClick={() => setSelectedId(style.id)}
                style={previewStyle(style, styles)}
                className={cx(
                  'block w-full truncate px-2 py-1 text-left text-[12px]',
                  selected?.id === style.id ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2'
                )}
              >
                {style.name}
              </button>
            </li>
          ))}
        </ul>

        {selected ? (
          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            <Field label="Name">
              <TextInput
                value={selected.name}
                onChange={(event) => patch({ name: event.target.value })}
                disabled={selected.builtin}
              />
            </Field>

            <Field label="Based on">
              <Select
                value={selected.basedOn ?? ''}
                onChange={(event) => patch({ basedOn: event.target.value || undefined })}
              >
                <option value="">(none)</option>
                {styles
                  .filter((style) => style.id !== selected.id)
                  .map((style) => (
                    <option key={style.id} value={style.id}>
                      {style.name}
                    </option>
                  ))}
              </Select>
            </Field>

            <Field label="Next paragraph">
              <Select
                value={selected.nextStyle ?? ''}
                onChange={(event) => patch({ nextStyle: event.target.value || undefined })}
              >
                <option value="">(same)</option>
                {styles.map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.name}
                  </option>
                ))}
              </Select>
            </Field>

            <SectionTitle>Text</SectionTitle>
            {/*
              Suggestions, not the ceiling: the datalist offers the safe
              cross-platform stacks and the project's own imported fonts, and
              any installed face can be typed by name — the old select made
              ten stacks the whole offer.
            */}
            <Field label="Font">
              <TextInput
                value={selected.text.fontFamily ?? ''}
                placeholder="(inherit)"
                list="style-font-options"
                data-testid="style-font"
                onChange={(event) => patchText({ fontFamily: event.target.value || undefined })}
              />
              <datalist id="style-font-options">
                {fonts.map((font) => (
                  <option key={font.id} value={font.family} />
                ))}
                {FONTS.map((font) => (
                  <option key={font} value={font}>
                    {font.split(',')[0]}
                  </option>
                ))}
              </datalist>
            </Field>
            <NumberField
              label="Size (pt)"
              value={selected.text.fontSize}
              onChange={(value) => patchText({ fontSize: value })}
            />
            <div className="mb-2 flex gap-3">
              <Checkbox
                label="Bold"
                checked={selected.text.bold ?? false}
                onChange={(checked) => patchText({ bold: checked })}
              />
              <Checkbox
                label="Italic"
                checked={selected.text.italic ?? false}
                onChange={(checked) => patchText({ italic: checked })}
              />
              <Checkbox
                label="Underline"
                checked={selected.text.underline ?? false}
                onChange={(checked) => patchText({ underline: checked })}
              />
            </div>

            <SectionTitle>Paragraph</SectionTitle>
            <Field label="Alignment">
              <Select
                value={selected.paragraph.align ?? ''}
                onChange={(event) =>
                  patchParagraph({ align: (event.target.value || undefined) as NamedStyle['paragraph']['align'] })
                }
              >
                <option value="">(inherit)</option>
                <option value="left">Left</option>
                <option value="center">Centre</option>
                <option value="right">Right</option>
                <option value="justify">Justified</option>
              </Select>
            </Field>
            <NumberField
              label="Line height"
              step={0.05}
              value={selected.paragraph.lineHeight}
              onChange={(value) => patchParagraph({ lineHeight: value })}
            />
            <NumberField
              label="Space before (pt)"
              value={selected.paragraph.spaceBefore}
              onChange={(value) => patchParagraph({ spaceBefore: value })}
            />
            <NumberField
              label="Space after (pt)"
              value={selected.paragraph.spaceAfter}
              onChange={(value) => patchParagraph({ spaceAfter: value })}
            />
            <NumberField
              label="Left indent (pt)"
              value={selected.paragraph.indentLeft}
              onChange={(value) => patchParagraph({ indentLeft: value })}
            />
            <NumberField
              label="First line indent (pt)"
              value={selected.paragraph.firstLineIndent}
              onChange={(value) => patchParagraph({ firstLineIndent: value })}
            />

            <SectionTitle>Project fonts</SectionTitle>
            <p className="mb-2 text-[11px] text-muted">
              An imported font is copied into the project, so it travels with it — to other
              machines, servers and OneDrive alike. Word export names the font but cannot embed
              the file; a reader without it installed sees a substitute.
            </p>
            {fonts.map((font) => (
              <div key={font.id} className="mb-1 flex items-center gap-2" data-testid="project-font">
                <span
                  className="min-w-0 flex-1 truncate text-[12px] text-text"
                  style={{ fontFamily: `"${font.family.replace(/["\\]/g, '')}"` }}
                  title={font.file}
                >
                  {font.family}
                </span>
                <ToolbarButton label={`Remove ${font.family}`} onClick={() => void removeFont(font)}>
                  ✕
                </ToolbarButton>
              </div>
            ))}
            <ToolbarButton
              label="Import a font file"
              className="mb-2 w-full justify-start"
              data-testid="import-font"
              onClick={() => void importFont()}
            >
              ＋ import font…
            </ToolbarButton>
          </div>
        ) : (
          <EmptyState title="Select a style" />
        )}
      </div>
    </PanelShell>
  )
}
