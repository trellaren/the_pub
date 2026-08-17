import Highlight from '@tiptap/extension-highlight'
import { ulid } from 'ulid'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    highlightId: {
      /**
       * Stamp a fresh `highlightId` on the `highlight` mark covering the
       * current selection, allocating one only if it doesn't already have
       * one. Does nothing if the selection has no highlight mark — collecting
       * is a deliberate act on already-highlighted text, not a way to create
       * a highlight. Returns the id used (existing or newly allocated) via
       * `onCollect`, since TipTap commands only report success/failure.
       */
      collectHighlight: (onCollect: (highlightId: string) => void) => ReturnType
    }
  }
}

/**
 * Extends the stock `highlight` mark with a lazily-allocated `highlightId`.
 *
 * Absent, a highlight is exactly what it always was: yellow (or whichever
 * colour) text, with nothing behind it. The id is stamped only by
 * `collectHighlight`, never by the ordinary colour-toggle commands the stock
 * extension already provides — so swiping a highlighter across a sentence and
 * changing your mind never leaves a ULID sitting in the document. See
 * `docs/phase-11-plan.md`.
 */
export const HighlightId = Highlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      highlightId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-highlight-id'),
        renderHTML: (attributes) =>
          attributes.highlightId ? { 'data-highlight-id': attributes.highlightId } : {}
      }
    }
  },

  // A highlight is colour alone otherwise — the category itself lives in the
  // Research sidecar, not on the mark, so the label a screen reader gets is
  // generic rather than the category name; still better than silent prose.
  renderHTML({ HTMLAttributes }) {
    return [
      'mark',
      HTMLAttributes,
      ['span', { class: 'pub-sr-only', contenteditable: 'false' }, 'highlight: '],
      ['span', {}, 0]
    ]
  },

  addCommands() {
    return {
      ...this.parent?.(),
      collectHighlight:
        (onCollect) =>
        ({ state, commands }) => {
          const { from, to } = state.selection
          let existingId: string | null = null
          let hasHighlight = false
          state.doc.nodesBetween(from, to, (node) => {
            const mark = node.marks.find((candidate) => candidate.type.name === this.name)
            if (!mark) return
            hasHighlight = true
            if (typeof mark.attrs.highlightId === 'string' && mark.attrs.highlightId) {
              existingId = mark.attrs.highlightId
            }
          })
          if (!hasHighlight) return false

          const id = existingId ?? ulid()
          const applied = commands.updateAttributes(this.name, { highlightId: id })
          if (applied) onCollect(id)
          return applied
        }
    }
  }
})
