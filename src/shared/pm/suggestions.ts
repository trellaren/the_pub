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
  return { ...doc, content: (doc.content ?? []).map((node) => resolveNode(node, accept, filter, null)) } as PmDoc
}

/**
 * Apply a verdict to exactly one suggestion: the `index`th entry of
 * `listSuggestions(doc)`. Other suggestions by the same author of the same
 * kind elsewhere in the chapter are left alone — a filter by author and mark
 * alone could not tell them apart.
 */
export function resolveSuggestionAt(doc: PmDoc, accept: boolean, index: number): PmDoc {
  const targets = new Set<PmNode>()
  for (const run of groupRuns(doc, {})) if (run.group === index) targets.add(run.node)
  if (targets.size === 0) return doc
  return { ...doc, content: (doc.content ?? []).map((node) => resolveNode(node, accept, {}, targets)) } as PmDoc
}

function resolveNode(
  node: PmNode,
  accept: boolean,
  filter: SuggestionFilter,
  targets: Set<PmNode> | null
): PmNode {
  const children = node.content
  if (!children) return node

  const kept: PmNode[] = []
  for (const child of children) {
    const found = !targets || targets.has(child) ? suggestionOn(child, filter) : null
    if (found) {
      // Removal is the same operation in both diagonals of the table: accepting
      // a deletion and rejecting an insertion both mean "this text goes".
      const removes = found.type === DELETION_MARK ? accept : !accept
      if (removes) continue
      // Every mark of that kind, not just the first: the marks exclude nothing,
      // so text typed into a pending insertion can carry one per keystroke.
      kept.push({
        ...child,
        marks: (child.marks ?? []).filter((mark) => mark.type !== found.type || !matches(mark, filter))
      })
      continue
    }
    kept.push(resolveNode(child, accept, filter, targets))
  }
  return { ...node, content: kept }
}

interface SuggestionRun {
  node: PmNode
  mark: { type: string; attrs?: Record<string, unknown> }
  blockIndex: number
  group: number
}

/**
 * Every suggestion-marked text node in reading order, numbered by the
 * suggestion it belongs to. Listing and single-suggestion resolution both
 * number from here, so the index the panel shows is the index the resolver
 * acts on.
 *
 * Adjacent runs of the same author's same verdict are one suggestion: the
 * editor splits text nodes for all sorts of reasons — a bold word inside an
 * insertion — and a panel listing each fragment would be a panel nobody can
 * read. Anything else in between ends the run, so two separate edits by the
 * same author in one paragraph stay two.
 */
function groupRuns(doc: PmDoc, filter: SuggestionFilter): SuggestionRun[] {
  const runs: SuggestionRun[] = []
  let group = -1
  let open: { type: string; authorId: string; blockIndex: number } | null = null
  const visit = (node: PmNode, blockIndex: number): void => {
    const mark = suggestionOn(node, filter)
    if (mark && node.type === 'text') {
      const authorId = String(mark.attrs?.authorId ?? '')
      if (!open || open.type !== mark.type || open.authorId !== authorId || open.blockIndex !== blockIndex) {
        group++
        open = { type: mark.type, authorId, blockIndex }
      }
      runs.push({ node, mark, blockIndex, group })
      return
    }
    if (!node.content) {
      open = null
      return
    }
    for (const child of node.content) visit(child, blockIndex)
  }
  const content = doc.content ?? []
  for (let blockIndex = 0; blockIndex < content.length; blockIndex++) visit(content[blockIndex]!, blockIndex)
  return runs
}

/** Every pending suggestion in the document, in reading order. */
export function listSuggestions(doc: PmDoc, filter: SuggestionFilter = {}): PendingSuggestion[] {
  const found: PendingSuggestion[] = []
  for (const run of groupRuns(doc, filter)) {
    const existing = found[run.group]
    if (existing) {
      existing.text += run.node.text ?? ''
      continue
    }
    const attrs = run.mark.attrs ?? {}
    found.push({
      mark: run.mark.type as typeof INSERTION_MARK,
      authorId: String(attrs.authorId ?? ''),
      at: String(attrs.at ?? ''),
      blockIndex: run.blockIndex,
      text: run.node.text ?? ''
    })
  }
  return found
}

/** Whether anything is awaiting a verdict, for a panel badge. */
export function hasSuggestions(doc: PmDoc): boolean {
  return listSuggestions(doc).length > 0
}

/** Everyone with a pending suggestion in this document. */
export function suggestionAuthors(doc: PmDoc): string[] {
  return [...new Set(listSuggestions(doc).map((suggestion) => suggestion.authorId))]
}
