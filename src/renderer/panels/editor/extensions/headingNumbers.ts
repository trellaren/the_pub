import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { NamedStyle } from '@shared/model/style.js'
import type { PmDoc } from '@shared/model/document.js'
import { computeHeadingNumbers } from '@shared/pm/headingNumbers.js'

export interface HeadingNumbersOptions {
  /** Live getter, same reasoning as every other extension's `getStyles`. */
  getStyles: () => NamedStyle[]
}

const headingNumbersKey = new PluginKey('headingNumbers')

/**
 * Renders each numbered heading's "1.2.3" as a widget before its text — a
 * decoration, not content, so the number is never selectable, never in the
 * undo history, and never picked up by search/word count/`extractPlainText`.
 * Recomputed from `computeHeadingNumbers` on every decoration pass rather
 * than stored, the same reasoning `Footnote`'s numbering plugin documents: a
 * stored number is wrong the instant a heading is inserted above it.
 */
export const HeadingNumbers = Extension.create<HeadingNumbersOptions>({
  name: 'headingNumbers',

  addOptions() {
    return { getStyles: () => [] }
  },

  addProseMirrorPlugins() {
    const getStyles = this.options.getStyles
    return [
      new Plugin({
        key: headingNumbersKey,
        props: {
          decorations(state) {
            const numbers = computeHeadingNumbers(state.doc.toJSON() as PmDoc, getStyles())
            if (numbers.size === 0) return null
            const decorations: Decoration[] = []
            let blockIndex = 0
            state.doc.forEach((_node, offset) => {
              const number = numbers.get(blockIndex)
              blockIndex++
              if (!number) return
              const widget = document.createElement('span')
              widget.className = 'pub-heading-number'
              // No extra space appended: `number` is `levelText` rendered
              // verbatim, and every numbering config in this codebase already
              // ends its `levelText` with the separator it wants ("%1. ") —
              // the same string DOCX numbering and the TOC's `number` field
              // read, so all three agree on spacing without this widget
              // adding its own.
              widget.textContent = number
              decorations.push(Decoration.widget(offset + 1, widget, { side: -1 }))
            })
            return DecorationSet.create(state.doc, decorations)
          }
        }
      })
    ]
  }
})
