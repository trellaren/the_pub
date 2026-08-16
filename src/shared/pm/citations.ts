import type { PmDoc, PmNode } from '../model/document.js'
import { FIELD_NODE } from '../model/field.js'
import { FOOTNOTE_NODE } from '../model/footnote.js'

/**
 * Every source id cited anywhere in the document, in order of first citation
 * and deduplicated — what a "works cited" bibliography lists, as opposed to
 * every source the project's library happens to hold.
 */
export function citedSourceIds(doc: PmDoc): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const occurrence of listCitations(doc)) {
    const sourceIds = occurrence.node.attrs?.sourceIds
    if (!Array.isArray(sourceIds)) continue
    for (const id of sourceIds) {
      if (typeof id !== 'string' || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

export interface CitationOccurrence {
  node: PmNode
  /** The footnote this citation sits inside, numbered as `pm/footnotes.ts` numbers it — or `null` for an inline citation. */
  noteNumber: number | null
}

/**
 * Every `citation`-kind field in the document, in the order a reader
 * encounters them — which is also the order `refreshCitations` must feed them
 * to citeproc, since `ibid.` and disambiguation both depend on citation order.
 *
 * The footnote-counting logic mirrors `pm/footnotes.ts`'s `listFootnotes`
 * exactly (increment on encountering a `footnote` node, in the same
 * document-order walk) so a citation's `noteNumber` here always agrees with
 * that footnote's own number.
 */
export function listCitations(doc: PmDoc): CitationOccurrence[] {
  const occurrences: CitationOccurrence[] = []
  let noteCount = 0

  const visit = (node: PmNode, insideNote: number | null): void => {
    for (const child of node.content ?? []) {
      if (child.type === FOOTNOTE_NODE) {
        noteCount++
        visit(child, noteCount)
        continue
      }
      if (child.type === FIELD_NODE && child.attrs?.kind === 'citation') {
        occurrences.push({ node: child, noteNumber: insideNote })
      }
      visit(child, insideNote)
    }
  }
  visit({ type: 'doc', content: doc.content ?? [] }, null)
  return occurrences
}
