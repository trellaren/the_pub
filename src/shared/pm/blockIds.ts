import type { PmDoc, PmNode } from '../model/document.js'

/**
 * Node types that carry a `blockId`.
 *
 * Deliberately narrow for now: nothing references a block yet (that starts
 * with cross-references and tables of contents), and widening this set later
 * — to tables, images, whatever needs to be a link target — costs one line
 * here, not a migration.
 */
export const BLOCK_ID_TYPES: ReadonlySet<string> = new Set(['paragraph', 'heading'])

function blockIdOf(node: PmNode): string | null {
  const id = node.attrs?.blockId
  return typeof id === 'string' && id ? id : null
}

/** Every `blockId` in the document, wherever it sits in the tree. */
export function collectBlockIds(doc: PmDoc): Set<string> {
  const ids = new Set<string>()
  const visit = (node: PmNode): void => {
    if (BLOCK_ID_TYPES.has(node.type)) {
      const id = blockIdOf(node)
      if (id) ids.add(id)
    }
    node.content?.forEach(visit)
  }
  ;(doc.content ?? []).forEach(visit)
  return ids
}

export interface DedupeResult {
  doc: PmDoc
  /** Whether any id was reassigned — callers use this to skip a no-op write. */
  changed: boolean
}

/**
 * Reassign a fresh id to every occurrence of a `blockId` after its first.
 *
 * The ordinary way to get a duplicate is copy-paste: pasting a paragraph that
 * already carries an id duplicates it, and two blocks claiming the same id is
 * worse than neither having one — a future cross-reference or bookmark would
 * resolve to whichever one a tree walk happens to visit first. `makeId` is
 * injected so a test can hand it a deterministic generator instead of the
 * real `ulid()`.
 */
export function dedupeBlockIds(doc: PmDoc, makeId: () => string): DedupeResult {
  const seen = new Set<string>()
  let changed = false

  const visit = (node: PmNode): PmNode => {
    let next = node
    if (BLOCK_ID_TYPES.has(node.type)) {
      const id = blockIdOf(node)
      if (id) {
        if (seen.has(id)) {
          changed = true
          // `makeId` is trusted to be collision-free against the rest of the
          // universe, not against ids this same pass has already minted — so
          // check, rather than assume a second draw can't repeat a first.
          let freshId = makeId()
          while (seen.has(freshId)) freshId = makeId()
          seen.add(freshId)
          next = { ...node, attrs: { ...node.attrs, blockId: freshId } }
        } else {
          seen.add(id)
        }
      }
    }
    if (next.content) {
      const content = next.content.map(visit)
      if (content.some((child, index) => child !== next.content![index])) {
        next = { ...next, content }
      }
    }
    return next
  }

  const content = (doc.content ?? []).map(visit)
  const original = doc.content ?? []
  const contentChanged = content.some((child, index) => child !== original[index])
  return { doc: contentChanged ? { ...doc, content } : doc, changed }
}
