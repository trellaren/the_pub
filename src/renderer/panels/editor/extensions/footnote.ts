import { Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { FOOTNOTE_NODE } from '@shared/model/footnote.js'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnote: {
      /** Insert an empty footnote at the current selection and open it for editing. */
      insertFootnote: () => ReturnType
    }
  }
}

const footnoteViewKey = new PluginKey<{ openPos: number | null }>('footnoteView')

/**
 * A footnote: a superscript marker inline in the text, with its own content —
 * one or more paragraphs — carried inside the node rather than addressed by
 * id. That is what makes deleting the marker delete the note, and cut/paste
 * carry it: there is nothing elsewhere in the document pointing back at it.
 *
 * Numbering is never stored — the plugin below recomputes it from document
 * order on every decoration pass, the same way `pm/footnotes.ts` does for the
 * JSON representation the endnotes region and DOCX export read.
 *
 * The note's content is real, always-present ProseMirror content (not a
 * separate nested editor): `.pub-footnote-body` is the single DOM element
 * ProseMirror manages for it, and CSS alone toggles it between hidden and a
 * floating popover. That keeps this to one plugin instead of the nested-
 * EditorView machinery the classic ProseMirror footnote example needs.
 */
export const Footnote = Node.create({
  name: FOOTNOTE_NODE,
  group: 'inline',
  inline: true,
  content: 'paragraph+',
  isolating: true,
  defining: true,
  selectable: true,
  atom: false,

  parseHTML() {
    return [{ tag: 'span[data-footnote]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'pub-footnote', 'data-footnote': '' }),
      ['span', { class: 'pub-footnote-body' }, 0]
    ]
  },

  addCommands() {
    return {
      insertFootnote:
        () =>
        ({ chain, state }) => {
          const pos = state.selection.from
          return chain()
            .insertContentAt(pos, { type: this.name, content: [{ type: 'paragraph' }] })
            .command(({ tr }) => {
              tr.setMeta(footnoteViewKey, pos)
              return true
            })
            .focus(pos + 2)
            .run()
        }
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<{ openPos: number | null }>({
        key: footnoteViewKey,
        state: {
          init: (): { openPos: number | null } => ({ openPos: null }),
          apply(tr, value) {
            const meta = tr.getMeta(footnoteViewKey)
            if (meta !== undefined) return { openPos: meta as number | null }
            if (value.openPos === null || !tr.docChanged) return value
            const mapped = tr.mapping.mapResult(value.openPos)
            return { openPos: mapped.deleted ? null : mapped.pos }
          }
        },
        props: {
          decorations(state) {
            const { openPos } = footnoteViewKey.getState(state)!
            const decorations: Decoration[] = []
            let number = 0
            state.doc.descendants((node, pos) => {
              if (node.type.name !== FOOTNOTE_NODE) return
              number++
              const attrs: Record<string, string> = { 'data-number': String(number) }
              if (pos === openPos) attrs.class = 'is-open'
              decorations.push(Decoration.node(pos, pos + node.nodeSize, attrs))
            })
            return DecorationSet.create(state.doc, decorations)
          },
          // Clicking a footnote opens its popover; clicking anywhere else closes
          // whichever one was open. Returning `false` either way leaves normal
          // click handling (cursor placement) to run afterwards.
          handleClick(view, pos) {
            const $pos = view.state.doc.resolve(pos)
            let footnotePos: number | null = null
            for (let depth = $pos.depth; depth >= 0; depth--) {
              if ($pos.node(depth).type.name === FOOTNOTE_NODE) {
                footnotePos = $pos.before(depth)
                break
              }
            }
            if (footnotePos === footnoteViewKey.getState(view.state)!.openPos) return false
            view.dispatch(view.state.tr.setMeta(footnoteViewKey, footnotePos))
            return false
          },
          handleKeyDown(view, event) {
            if (event.key !== 'Escape') return false
            if (footnoteViewKey.getState(view.state)!.openPos === null) return false
            view.dispatch(view.state.tr.setMeta(footnoteViewKey, null))
            return true
          }
        }
      })
    ]
  }
})

/** Open (or close, with `null`) the footnote at `pos` — used by the endnotes region. */
export function setFootnoteOpen(view: EditorView, pos: number | null): void {
  view.dispatch(view.state.tr.setMeta(footnoteViewKey, pos))
}

/**
 * The live document position of the `number`-th footnote (1-based, document
 * order) — what the endnotes region needs to jump to and open one, since a
 * `listFootnotes` entry only knows its place in the JSON, not a live position.
 */
export function findFootnotePos(state: EditorState, number: number): number | null {
  let found: number | null = null
  let count = 0
  state.doc.descendants((node, pos) => {
    if (node.type.name !== FOOTNOTE_NODE) return
    count++
    if (count === number) found = pos
  })
  return found
}
