import { Extension, type CommandProps, type SingleCommands } from '@tiptap/core'

export const INDENT_STEP_PT = 24
const MAX_INDENT_PT = 240

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphFormat: {
      setParagraphLineHeight: (value: number | null) => ReturnType
      setSpaceBefore: (value: number | null) => ReturnType
      setSpaceAfter: (value: number | null) => ReturnType
      setFirstLineIndent: (value: number | null) => ReturnType
      indent: () => ReturnType
      outdent: () => ReturnType
      setParagraphDir: (dir: 'rtl' | 'ltr' | null) => ReturnType
      clearParagraphFormat: () => ReturnType
    }
  }
}

/** One attribute → one CSS declaration. TipTap merges them into a single style attribute. */
function pointAttribute(cssProperty: string, dataName: string) {
  return {
    default: null as number | null,
    parseHTML: (element: HTMLElement): number | null => {
      const raw = element.getAttribute(`data-${dataName}`)
      return raw === null ? null : Number(raw)
    },
    renderHTML: (attributes: Record<string, unknown>): Record<string, string> => {
      const value = attributes[camel(dataName)]
      if (value === null || value === undefined) return {}
      return { style: `${cssProperty}: ${value}pt`, [`data-${dataName}`]: String(value) }
    }
  }
}

function camel(dashed: string): string {
  return dashed.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

/**
 * Direct paragraph formatting — the manual overrides a writer applies on top of
 * a named style (Word's "direct formatting"). Stored per block and rendered as
 * inline styles, so they win over the generated style sheet.
 */
export const ParagraphFormat = Extension.create({
  name: 'paragraphFormat',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          indentLeft: pointAttribute('margin-left', 'indent-left'),
          // No toolbar control sets this one; it exists so a right indent
          // imported from a Word document has somewhere to land instead of
          // being silently dropped.
          indentRight: pointAttribute('margin-right', 'indent-right'),
          spaceBefore: pointAttribute('margin-top', 'space-before'),
          spaceAfter: pointAttribute('margin-bottom', 'space-after'),
          firstLineIndent: pointAttribute('text-indent', 'first-line-indent'),
          // Only `rtl` is ever written explicitly — `ltr` is the HTML default,
          // so storing `null` for it keeps documents that never touch direction
          // free of a `dir` attribute entirely.
          dir: {
            default: null as 'rtl' | null,
            parseHTML: (element: HTMLElement): 'rtl' | null =>
              element.getAttribute('dir') === 'rtl' ? 'rtl' : null,
            renderHTML: (attributes: Record<string, unknown>): Record<string, string> =>
              attributes.dir === 'rtl' ? { dir: 'rtl' } : {}
          },
          lineHeight: {
            default: null as number | null,
            parseHTML: (element: HTMLElement): number | null => {
              const raw = element.getAttribute('data-line-height')
              return raw === null ? null : Number(raw)
            },
            renderHTML: (attributes: Record<string, unknown>): Record<string, string> => {
              const value = attributes.lineHeight
              if (value === null || value === undefined) return {}
              return { style: `line-height: ${value}`, 'data-line-height': String(value) }
            }
          }
        }
      }
    ]
  },

  addCommands() {
    // Applies to whichever block type the selection is in; `updateAttributes`
    // returns false when the node type doesn't match, so the fallback covers
    // headings without needing to inspect the selection.
    const setOnBlocks =
      (attribute: string) =>
      (value: number | null) =>
      ({ commands }: { commands: SingleCommands }): boolean => {
        const update = { [attribute]: value }
        return (
          commands.updateAttributes('paragraph', update) ||
          commands.updateAttributes('heading', update)
        )
      }

    const shiftIndent =
      (direction: 1 | -1) =>
      () =>
      ({ editor, commands }: CommandProps): boolean => {
        const current = (editor.getAttributes('paragraph').indentLeft ??
          editor.getAttributes('heading').indentLeft ??
          0) as number
        const next = Math.min(MAX_INDENT_PT, Math.max(0, current + direction * INDENT_STEP_PT))
        const value = next === 0 ? null : next
        return (
          commands.updateAttributes('paragraph', { indentLeft: value }) ||
          commands.updateAttributes('heading', { indentLeft: value })
        )
      }

    return {
      setParagraphLineHeight: setOnBlocks('lineHeight'),
      setSpaceBefore: setOnBlocks('spaceBefore'),
      setSpaceAfter: setOnBlocks('spaceAfter'),
      setFirstLineIndent: setOnBlocks('firstLineIndent'),
      indent: shiftIndent(1),
      outdent: shiftIndent(-1),
      // Direction and alignment are coupled: a `left`/`right` alignment set
      // while a paragraph was LTR means nothing once the paragraph flips to
      // RTL — the physical side it named may now be the trailing edge, not
      // the leading one. Converting to the logical equivalent on toggle is
      // what keeps `left` meaning "the start" rather than quietly becoming
      // wrong the moment `dir` changes.
      setParagraphDir:
        (dir: 'rtl' | 'ltr' | null) =>
        ({ editor, commands }: CommandProps): boolean => {
          const value = dir === 'rtl' ? 'rtl' : null
          const currentAlign = (editor.getAttributes('paragraph').textAlign ??
            editor.getAttributes('heading').textAlign ??
            null) as string | null
          const remap: Record<string, string> = value
            ? { left: 'start', right: 'end' }
            : { start: 'left', end: 'right' }
          const nextAlign = currentAlign && remap[currentAlign] ? remap[currentAlign] : currentAlign

          const dirOk =
            commands.updateAttributes('paragraph', { dir: value }) ||
            commands.updateAttributes('heading', { dir: value })
          if (nextAlign && nextAlign !== currentAlign) {
            editor.chain().setTextAlign(nextAlign).run()
          }
          return dirOk
        },
      clearParagraphFormat:
        () =>
        ({ commands }) => {
          const cleared = {
            indentLeft: null,
            spaceBefore: null,
            spaceAfter: null,
            firstLineIndent: null,
            lineHeight: null
          }
          return (
            commands.updateAttributes('paragraph', cleared) ||
            commands.updateAttributes('heading', cleared)
          )
        }
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-]': () => this.editor.commands.indent(),
      'Mod-[': () => this.editor.commands.outdent()
    }
  }
})
