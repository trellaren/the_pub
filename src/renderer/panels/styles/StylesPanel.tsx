import { useState } from 'react'
import type { NamedStyle } from '@shared/model/style.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { PanelShell, PanelHeader, EmptyState, Select, TextInput, ToolbarButton, cx } from '@renderer/ui/primitives.js'
import { previewStyle } from '@renderer/panels/editor/extensions/namedStyles.js'

const FONTS = [
  'Georgia, serif',
  'Iowan Old Style, serif',
  'Times New Roman, serif',
  'Helvetica, Arial, sans-serif',
  'Courier New, monospace'
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

  const removeStyle = (): void => {
    if (!selected || selected.builtin) return
    void updateManifest((manifest) => ({
      ...manifest,
      styles: manifest.styles.filter((style) => style.id !== selected.id)
    }))
    setSelectedId(null)
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
            <Field label="Font">
              <Select
                value={selected.text.fontFamily ?? ''}
                onChange={(event) => patchText({ fontFamily: event.target.value || undefined })}
              >
                <option value="">(inherit)</option>
                {FONTS.map((font) => (
                  <option key={font} value={font}>
                    {font.split(',')[0]}
                  </option>
                ))}
              </Select>
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
          </div>
        ) : (
          <EmptyState title="Select a style" />
        )}
      </div>
    </PanelShell>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-4 mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">{children}</h3>
  )
}

/**
 * Label above control rather than beside it: this panel is usually docked to a
 * narrow sidebar, where a side-by-side layout pushes the input out of view.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 flex flex-col gap-1 text-[12px] text-muted">
      <span>{label}</span>
      {children}
    </label>
  )
}

function NumberField({
  label,
  value,
  step = 1,
  onChange
}: {
  label: string
  value: number | undefined
  step?: number
  onChange: (value: number | undefined) => void
}) {
  return (
    <Field label={label}>
      <TextInput
        type="number"
        step={step}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
      />
    </Field>
  )
}

function Checkbox({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-1 text-[12px] text-muted">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}
