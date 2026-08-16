import type { PmDoc, PmNode } from '../model/document.js'
import { DELETION_MARK, INSERTION_MARK, isSuggestionMark } from '../model/suggestion.js'

/**
 * Accepting and rejecting suggested edits.
 *
 * Pure functions over document JSON, not editor commands: the same four
 * operations have to run from the review panel, from an accept-all, and from
 * the Word importer, and a version that needed a live `EditorView` would be
 * three versions.
 *
 * The four cases are two pairs of inverses, and stating them plainly is most of
 * the correctness:
 *
 * | | accept | reject |
 * |---|---|---|
 * | `insertion` | keep the text, strip the mark | remove the text |
 * | `deletion` | remove the text | keep the text, strip the mark |
 *
 * Which is to say: accepting an insertion and rejecting a deletion are the same
 * operation, and so are the other two. That is why this is one small function
 * with a flag rather than four.
 */

export interface SuggestionFilter {
  /** Only this author's suggestions. Empty means everyone's. */
  authorId?: string
  /** Only this kind. Absent means both. */
  mark?: typeof INSERTION_MARK | typeof DELETION_MARK
}

/** One pending suggestion, for the review panel to list and jump to. */
export interface PendingSuggestion {
  mark: typeof INSERTION_MARK | typeof DELETION_MARK
  authorId: string
  at: string
  blockIndex: number
  text: string
}

function matches(mark: { type: string; attrs?: Record<string, unknown> }, filter: SuggestionFilter): boolean {
  if (!isSuggestionMark(mark.type)) return false
  if (filter.mark && mark.type !== filter.mark) return false
  if (filter.authorId && mark.attrs?.authorId !== filter.authorId) return false
  return true
}

function suggestionOn(
  node: PmNode,
  filter: SuggestionFilter
): { type: string; attrs?: Record<string, unknown> } | null {
  return node.marks?.find((mark) => matches(mark, filter)) ?? null
}

/**
 * Apply a verdict to every matching suggestion.
 *
 * `accept` is the verdict, not the direction: what it *does* depends on which
 * mark it lands on, per the table above.
 */
export function resolveSuggestions(doc: PmDoc, accept: boolean, filter: SuggestionFilter = {}): PmDoc {
  return { ...doc, content: (doc.content ?? []).map((node) => resolveNode(node, accept, filter)) } as PmDoc
}

function resolveNode(node: PmNode, accept: boolean, filter: SuggestionFilter): PmNode {
  const children = node.content
  if (!children) return node

  const kept: PmNode[] = []
  for (const child of children) {
    const found = suggestionOn(child, filter)
    if (found) {
      // Removal is the same operation in both diagonals of the table: accepting
      // a deletion and rejecting an insertion both mean "this text goes".
      const removes = found.type === DELETION_MARK ? accept : !accept
      if (removes) continue
      kept.push({ ...child, marks: (child.marks ?? []).filter((mark) => mark !== found) })
      continue
    }
    kept.push(resolveNode(child, accept, filter))
  }
  return { ...node, content: kept }
}

/** Every pending suggestion in the document, in reading order. */
export function listSuggestions(doc: PmDoc, filter: SuggestionFilter = {}): PendingSuggestion[] {
  const found: PendingSuggestion[] = []
  const content = doc.content ?? []
  for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
    collect(content[blockIndex]!, blockIndex, filter, found)
  }
  return found
}

function collect(
  node: PmNode,
  blockIndex: number,
  filter: SuggestionFilter,
  into: PendingSuggestion[]
): void {
  const mark = suggestionOn(node, filter)
  if (mark && node.type === 'text') {
    const previous = into[into.length - 1]
    const attrs = mark.attrs ?? {}
    const authorId = String(attrs.authorId ?? '')
    // Adjacent runs of the same author's same verdict are one suggestion. The
    // editor splits text nodes for all sorts of reasons — a bold word inside an
    // insertion — and a panel listing each fragment separately would be a panel
    // nobody can read.
    if (
      previous &&
      previous.mark === mark.type &&
      previous.authorId === authorId &&
      previous.blockIndex === blockIndex
    ) {
      previous.text += node.text ?? ''
      return
    }
    into.push({
      mark: mark.type as typeof INSERTION_MARK,
      authorId,
      at: String(attrs.at ?? ''),
      blockIndex,
      text: node.text ?? ''
    })
    return
  }
  for (const child of node.content ?? []) collect(child, blockIndex, filter, into)
}

/** Whether anything is awaiting a verdict, for a panel badge. */
export function hasSuggestions(doc: PmDoc): boolean {
  return listSuggestions(doc).length > 0
}

/** Everyone with a pending suggestion in this document. */
export function suggestionAuthors(doc: PmDoc): string[] {
  return [...new Set(listSuggestions(doc).map((suggestion) => suggestion.authorId))]
}
