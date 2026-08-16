import type { PmDoc, PmNode } from '../model/document.js'
import { FIELD_NODE, type FieldKind } from '../model/field.js'

/**
 * A "field run": a contiguous sequence of top-level paragraphs, each holding
 * exactly one field of the given kind. A table of contents and a
 * bibliography are both one of these — a block of computed, one-field-per-
 * paragraph entries that a refresh replaces as a whole rather than diffing
 * entry by entry, which is what lets "insert" and "refresh" be the same
 * command (see `fieldActions.ts`'s `insertOrRefreshTableOfContents`).
 */
function isFieldParagraph(node: PmNode, kind: FieldKind): boolean {
  const content = node.content
  return (
    node.type === 'paragraph' &&
    content?.length === 1 &&
    content[0]?.type === FIELD_NODE &&
    content[0]?.attrs?.kind === kind
  )
}

/** [start, end) top-level child indexes of an existing run of `kind` fields, or null. */
export function findFieldRunRange(doc: PmDoc, kind: FieldKind): { start: number; end: number } | null {
  const content = doc.content ?? []
  const start = content.findIndex((node) => isFieldParagraph(node, kind))
  if (start === -1) return null
  let end = start + 1
  while (end < content.length && isFieldParagraph(content[end]!, kind)) end++
  return { start, end }
}
