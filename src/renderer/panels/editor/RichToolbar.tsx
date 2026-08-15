import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { STYLE_BODY, type NamedStyle } from '@shared/model/style.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { ToolbarButton, Divider, Select, cx } from '@renderer/ui/primitives.js'
import { previewStyle, defaultStyleFor } from './extensions/namedStyles.js'
import { invoke } from '@renderer/lib/ipc.js'
import { bytesToBase64 } from '@renderer/lib/assets.js'

const FONTS = [
  'Georgia, serif',
  'Iowan Old Style, serif',
  'Palatino Linotype, serif',
  'Times New Roman, serif',
  'Helvetica, Arial, sans-serif',
  'Verdana, sans-serif',
  'Courier New, monospace'
]
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 48]
const LINE_HEIGHTS = [1, 1.15, 1.5, 1.6, 2, 2.5]
const HIGHLIGHTS = ['#ffe066', '#a5d8ff', '#b2f2bb', '#ffc9c9', '#eebefa']
const NO_STYLES: NamedStyle[] = []

/**
 * Word-style formatting controls.
 *
 * Re-renders on every editor transaction so the active state of each control
 * reflects the cursor — that feedback is what makes formatting feel direct
 * rather than guessed at.
 */
export function RichToolbar({ editor }: { editor: Editor }) {
  // The fallback is a shared constant, not a fresh `[]`: zustand compares
  // selector results by identity, and a new array every render is an infinite
  // re-render loop.
  const styles = useProjectStore((store) => store.project?.manifest.styles) ?? NO_STYLES
  const defaultStyleId =
    useProjectStore((store) => store.project?.manifest.settings.defaultStyleId) ?? STYLE_BODY
  const [, force] = useState(0)

  useEffect(() => {
    const update = (): void => force((tick) => tick + 1)
    editor.on('transaction', update)
    return () => {
      editor.off('transaction', update)
    }
  }, [editor])

  const isHeading = editor.isActive('heading')
  const blockAttributes = isHeading ? editor.getAttributes('heading') : editor.getAttributes('paragraph')
  // A block with no style of its own is still rendered with one, so the picker
  // shows that effective style rather than sitting blank.
  const currentStyleId =
    (blockAttributes.styleId as string | undefined) ??
    defaultStyleFor(
      isHeading ? 'heading' : 'paragraph',
      blockAttributes.level as number | undefined,
      styles,
      defaultStyleId
    )?.id ??
    ''
  const currentFont = (editor.getAttributes('textStyle').fontFamily as string | undefined) ?? ''
  const currentSize = parseSize(editor.getAttributes('textStyle').fontSize)

  const insertImage = async (): Promise<void> => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const buffer = await file.arrayBuffer()
      const base64 = bytesToBase64(new Uint8Array(buffer))
      const extension = file.name.split('.').pop() ?? 'png'
      const asset = await invoke('doc:writeAsset', { dataBase64: base64, ext: extension }).catch(() => null)
      if (asset) editor.chain().focus().setImage({ src: asset.url }).run()
    }
    input.click()
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border bg-surface px-2 py-1">
      <Select
        value={currentStyleId}
        title="Paragraph style"
        onChange={(event) => editor.chain().focus().setNamedStyle(event.target.value).run()}
        className="w-36"
        style={(() => {
          const active = styles.find((style) => style.id === currentStyleId)
          return active ? previewStyle(active, styles) : undefined
        })()}
      >
        <option value="" disabled>
          Style
        </option>
        {styles.map((style) => (
          <option key={style.id} value={style.id}>
            {style.name}
          </option>
        ))}
      </Select>

      <Select
        value={currentFont}
        title="Font"
        className="w-32"
        onChange={(event) => {
          const value = event.target.value
          if (value) editor.chain().focus().setFontFamily(value).run()
          else editor.chain().focus().unsetFontFamily().run()
        }}
      >
        <option value="">Style font</option>
        {FONTS.map((font) => (
          <option key={font} value={font} style={{ fontFamily: font }}>
            {font.split(',')[0]}
          </option>
        ))}
      </Select>

      <Select
        value={currentSize}
        title="Font size"
        className="w-16"
        onChange={(event) => {
          const value = event.target.value
          if (value) editor.chain().focus().setFontSize(`${value}pt`).run()
          else editor.chain().focus().unsetFontSize().run()
        }}
      >
        <option value="">pt</option>
        {SIZES.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </Select>

      <Divider />

      <ToolbarButton label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <span className="font-bold">B</span>
      </ToolbarButton>
      <ToolbarButton label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <span className="italic">I</span>
      </ToolbarButton>
      <ToolbarButton label="Underline" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <span className="underline">U</span>
      </ToolbarButton>
      <ToolbarButton label="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <span className="line-through">S</span>
      </ToolbarButton>
      <ToolbarButton label="Superscript" active={editor.isActive('superscript')} onClick={() => editor.chain().focus().toggleSuperscript().run()}>
        x²
      </ToolbarButton>
      <ToolbarButton label="Subscript" active={editor.isActive('subscript')} onClick={() => editor.chain().focus().toggleSubscript().run()}>
        x₂
      </ToolbarButton>

      <label className="ml-1 inline-flex h-7 cursor-pointer items-center rounded px-1 hover:bg-surface-3" title="Text colour">
        <span className="text-[12px] text-muted">A</span>
        <input
          type="color"
          className="ml-0.5 h-4 w-4 cursor-pointer border-0 bg-transparent p-0"
          onChange={(event) => editor.chain().focus().setColor(event.target.value).run()}
        />
      </label>

      <div className="flex items-center gap-0.5">
        {HIGHLIGHTS.map((colour) => (
          <button
            key={colour}
            type="button"
            title={`Highlight ${colour}`}
            aria-label={`Highlight ${colour}`}
            onClick={() => editor.chain().focus().toggleHighlight({ color: colour }).run()}
            style={{ background: colour }}
            className="h-4 w-4 rounded-sm border border-border"
          />
        ))}
        <ToolbarButton label="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearParagraphFormat().run()}>
          ⌫
        </ToolbarButton>
      </div>

      <Divider />

      {(['left', 'center', 'right', 'justify'] as const).map((alignment) => (
        <ToolbarButton
          key={alignment}
          label={`Align ${alignment}`}
          active={editor.isActive({ textAlign: alignment })}
          onClick={() => editor.chain().focus().setTextAlign(alignment).run()}
        >
          {ALIGN_GLYPHS[alignment]}
        </ToolbarButton>
      ))}

      <ToolbarButton label="Decrease indent" onClick={() => editor.chain().focus().outdent().run()}>
        ⇤
      </ToolbarButton>
      <ToolbarButton label="Increase indent" onClick={() => editor.chain().focus().indent().run()}>
        ⇥
      </ToolbarButton>

      <Select
        title="Line spacing"
        value={(blockAttributes.lineHeight as number | undefined) ?? ''}
        className="w-16"
        onChange={(event) => {
          const value = event.target.value
          editor.chain().focus().setParagraphLineHeight(value ? Number(value) : null).run()
        }}
      >
        <option value="">↕</option>
        {LINE_HEIGHTS.map((height) => (
          <option key={height} value={height}>
            {height}
          </option>
        ))}
      </Select>

      <Divider />

      <ToolbarButton label="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        ••
      </ToolbarButton>
      <ToolbarButton label="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        1.
      </ToolbarButton>
      <ToolbarButton label="Block quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        ❝
      </ToolbarButton>
      <ToolbarButton label="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        ―
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        label="Insert table"
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        ▦
      </ToolbarButton>
      {editor.isActive('table') ? (
        <>
          <ToolbarButton label="Add row" onClick={() => editor.chain().focus().addRowAfter().run()}>
            +↔
          </ToolbarButton>
          <ToolbarButton label="Add column" onClick={() => editor.chain().focus().addColumnAfter().run()}>
            +↕
          </ToolbarButton>
          <ToolbarButton label="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>
            ▦✕
          </ToolbarButton>
        </>
      ) : null}
      <ToolbarButton label="Insert image" onClick={() => void insertImage()}>
        ⛰
      </ToolbarButton>

      <Divider />

      <ToolbarButton label="Undo" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>
        ↶
      </ToolbarButton>
      <ToolbarButton label="Redo" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>
        ↷
      </ToolbarButton>
    </div>
  )
}

const ALIGN_GLYPHS = { left: '⬅', center: '↔', right: '➡', justify: '☰' } as const

function parseSize(value: unknown): string {
  if (typeof value !== 'string') return ''
  const match = /^(\d+(?:\.\d+)?)/.exec(value)
  return match ? match[1]! : ''
}

export { cx }
