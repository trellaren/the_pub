import type { PmDoc, PmNode } from '../model/document.js'
import { extractPlainText } from './extractText.js'
import { FOOTNOTE_NODE } from '../model/footnote.js'

export interface FootnoteEntry {
  /** 1-based, in document order. Never stored — recomputed on every read. */
  number: number
  node: PmNode
  /** The note's own text, flattened — what the endnotes region and DOCX export show. */
  text: string
}

/**
 * Every footnote in `doc`, numbered by where its marker sits in the text.
 *
 * Walks the whole tree, not just top-level blocks — a footnote can sit inside
 * a heading or a table cell just as easily as a plain paragraph — in document
 * order, which is what makes the numbering match what a reader encounters.
 */
export function listFootnotes(doc: PmDoc): FootnoteEntry[] {
  const entries: FootnoteEntry[] = []
  const visit = (node: PmNode): void => {
    for (const child of node.content ?? []) {
      if (child.type === FOOTNOTE_NODE) {
        entries.push({
          number: entries.length + 1,
          node: child,
          text: extractPlainText({ type: 'doc', content: child.content ?? [] })
        })
      }
      visit(child)
    }
  }
  visit({ type: 'doc', content: doc.content ?? [] })
  return entries
}
