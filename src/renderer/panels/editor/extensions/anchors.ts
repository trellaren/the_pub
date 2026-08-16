import { Mark, mergeAttributes } from '@tiptap/core'
import { ANCHOR_MARK } from '@shared/model/anchor.js'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    anchors: {
      /** Low-level only — nothing calls this yet. Notes (Phase 2) will. */
      setAnchor: (attributes: { anchorId: string }) => ReturnType
      unsetAnchor: () => ReturnType
    }
  }
}

/**
 * Identity for a range of text, independent of what points at it.
 *
 * A mark, for the same reason `Mention` is one: the text stays real text, so
 * search, word count and DOCX export are unaffected by whether a range
 * happens to be anchored. It carries only an id — never a note's content,
 * which belongs in a sidecar file, not in every `.pubdoc` that has one.
 *
 * Two divergences from `Mention`, both deliberate:
 * - `keepOnSplit: true`, not `false` — splitting an anchored paragraph should
 *   leave the anchor on both halves, not just the one Enter was pressed in.
 * - `excludes: ''`, not the mark's own name (ProseMirror's default) — two
 *   different things anchored to overlapping text is the ordinary case for
 *   comments, and the default would silently make a second one impossible to
 *   add over text a first one already covers.
 */
export const Anchors = Mark.create({
  name: ANCHOR_MARK,
  inclusive: false,
  keepOnSplit: true,
  excludes: '',

  addAttributes() {
    return {
      anchorId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-anchor-id'),
        renderHTML: (attributes) => (attributes.anchorId ? { 'data-anchor-id': attributes.anchorId } : {})
      }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-anchor-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'pub-anchor' }), 0]
  },

  addCommands() {
    return {
      setAnchor:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(ANCHOR_MARK, attributes),
      unsetAnchor:
        () =>
        ({ commands }) =>
          commands.unsetMark(ANCHOR_MARK)
    }
  }
})
