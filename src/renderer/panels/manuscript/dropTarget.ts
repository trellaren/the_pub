import {
  childrenOf,
  flattenManuscript,
  isPart,
  type ManuscriptNode
} from '../../../shared/model/manuscript.js'

/**
 * Where a move lands — by pointer, or by keyboard.
 *
 * A `.ts` file rather than `.tsx`, and pure: `vitest.config.ts` collects
 * `src/**\/*.test.ts` only, so geometry living beside a component would never be
 * tested. Everything here takes numbers and returns a destination; the panel
 * supplies the rects and draws the result.
 *
 * The one convention the whole module turns on: callers of this API speak in
 * **displayed** indices — positions among a parent's children as they appear on
 * screen, moving node included — and every destination returned is in
 * **excluding** coordinates, ready for `placeInManuscript`. Conflating the two
 * is what makes dragging a row down by one silently do nothing.
 */

/** A row a drop can be aimed at. */
export type DropRow =
  | { kind: 'node'; node: ManuscriptNode; depth: 0 | 1; siblingIndex: number }
  /** An expanded part with nothing in it: a real row, so "drop inside" has a target. */
  | { kind: 'placeholder'; partId: string }

export type Indicator =
  /** A rule drawn above row `row` (`rows.length` means below the last), indented to `depth`. */
  | { kind: 'between'; row: number; depth: 0 | 1 }
  /** The part row itself highlighted. No rule anywhere. */
  | { kind: 'inside'; partId: string }

export interface DropTarget {
  parentId: string | null
  /** Excluding the moving node — pass straight to `manuscript:move`. */
  index: number
  indicator: Indicator
}

/**
 * The rows to render and aim at.
 *
 * An expanded part with no children gets a placeholder row. A zero-height region
 * between two rows is not something a pointer can be expected to hit, so "drop
 * into an empty part" is given somewhere real to land rather than left to luck.
 */
export function dropRows(
  nodes: readonly ManuscriptNode[],
  collapsed: ReadonlySet<string> = new Set()
): DropRow[] {
  const rows: DropRow[] = []
  for (const row of flattenManuscript(nodes, collapsed)) {
    rows.push({ kind: 'node', node: row.node, depth: row.depth, siblingIndex: row.siblingIndex })
    if (isPart(row.node) && !collapsed.has(row.node.id) && childrenOf(nodes, row.node.id).length === 0) {
      rows.push({ kind: 'placeholder', partId: row.node.id })
    }
  }
  return rows
}

/**
 * Aim a drop.
 *
 * `fraction` is the pointer's position down the row, 0 at the top edge and 1 at
 * the bottom. A `rowIndex` outside the list means the empty space below the last
 * row, which is the end of the book.
 *
 * Returns null when there is nothing to do: a drop onto the node's own current
 * position, a part aimed inside anything, or a part aimed at its own subtree. A
 * null is drawn as no indicator at all, so the author is never shown a target
 * that would not move what they are holding.
 */
export function resolveDrop(
  nodes: readonly ManuscriptNode[],
  rows: readonly DropRow[],
  draggingId: string,
  rowIndex: number,
  fraction: number
): DropTarget | null {
  const moving = nodes.find((node) => node.id === draggingId)
  if (!moving) return null
  const movingIsPart = isPart(moving)

  // Past the last row: the end of the book, at the root.
  if (rowIndex < 0 || rowIndex >= rows.length) {
    return settle(nodes, moving, null, childrenOf(nodes, null).length, {
      kind: 'between',
      row: rows.length,
      depth: 0
    })
  }

  const row = rows[rowIndex]!

  if (row.kind === 'placeholder') {
    // Every band of a placeholder means the same thing; there is nothing else
    // it could mean.
    if (movingIsPart) return null
    return settle(nodes, moving, row.partId, 0, { kind: 'inside', partId: row.partId })
  }

  const node = row.node

  if (movingIsPart) {
    // A part cannot go inside a part, so its own row and its children's rows
    // offer nothing a root-level rule does not already offer elsewhere.
    if (node.id === draggingId || node.parentId === draggingId) return null
  }

  if (isPart(node)) {
    if (fraction < 0.25) {
      return settle(nodes, moving, null, row.siblingIndex, {
        kind: 'between',
        row: rowIndex,
        depth: 0
      })
    }
    if (fraction >= 0.75) {
      // Below the part *and everything visibly inside it* — a rule tucked under
      // the part's header but above its chapters would read as "inside".
      return settle(nodes, moving, null, row.siblingIndex + 1, {
        kind: 'between',
        row: endOfSubtree(rows, rowIndex),
        depth: 0
      })
    }
    if (movingIsPart) return null
    return settle(nodes, moving, node.id, childrenOf(nodes, node.id).length, {
      kind: 'inside',
      partId: node.id
    })
  }

  // A document has no inside, so its middle band joins its bottom band: every
  // pixel of the row means something, and there is no dead zone.
  const before = fraction < 0.25
  return settle(nodes, moving, node.parentId, row.siblingIndex + (before ? 0 : 1), {
    kind: 'between',
    row: rowIndex + (before ? 0 : 1),
    depth: row.depth
  })
}

/**
 * Convert a displayed index to an excluding one, and refuse a move that is not one.
 *
 * Both halves are the same insight. If the moving node already sits in the
 * destination, then a drop immediately before or immediately after it is the
 * position it is already in — nothing to write and nothing to draw — and every
 * position past it is counted one too high while it is still in the list.
 */
function settle(
  nodes: readonly ManuscriptNode[],
  moving: ManuscriptNode,
  parentId: string | null,
  displayedIndex: number,
  indicator: Indicator
): DropTarget | null {
  const siblings = childrenOf(nodes, parentId)
  const current = siblings.findIndex((node) => node.id === moving.id)
  if (current >= 0 && (displayedIndex === current || displayedIndex === current + 1)) return null
  const index = current >= 0 && displayedIndex > current ? displayedIndex - 1 : displayedIndex
  return { parentId, index, indicator }
}

/** The row index just past a part's visible children. */
function endOfSubtree(rows: readonly DropRow[], partRow: number): number {
  let end = partRow + 1
  while (end < rows.length && !isRootRow(rows[end]!)) end += 1
  return end
}

function isRootRow(row: DropRow): boolean {
  return row.kind === 'node' && row.depth === 0
}

/**
 * The keyboard cover.
 *
 * These four reach every position in the tree from every other, which is what
 * makes reordering usable without a pointer — and, just as much, what makes it
 * testable: a click is deterministic where a synthesised drag is a negotiation
 * with the browser. Each returns a destination in excluding coordinates, or null
 * when the move has nowhere to go.
 */
export type Move = 'up' | 'down' | 'indent' | 'outdent'

export function resolveMove(
  nodes: readonly ManuscriptNode[],
  id: string,
  move: Move
): { parentId: string | null; index: number } | null {
  const node = nodes.find((candidate) => candidate.id === id)
  if (!node) return null
  const siblings = childrenOf(nodes, node.parentId)
  const position = siblings.findIndex((candidate) => candidate.id === id)
  if (position < 0) return null

  switch (move) {
    case 'up':
      return position === 0 ? null : { parentId: node.parentId, index: position - 1 }
    case 'down':
      return position === siblings.length - 1 ? null : { parentId: node.parentId, index: position + 1 }
    case 'indent': {
      // Into the part directly above, at its end — the reading that matches what
      // indenting a line does in every outliner. Parts do not indent: two levels.
      if (isPart(node) || node.parentId !== null) return null
      const above = siblings[position - 1]
      if (!above || !isPart(above)) return null
      return { parentId: above.id, index: childrenOf(nodes, above.id).length }
    }
    case 'outdent': {
      if (node.parentId === null) return null
      const parents = childrenOf(nodes, null)
      const parentPosition = parents.findIndex((candidate) => candidate.id === node.parentId)
      // Immediately after the part it is leaving, so an outdent visibly moves the
      // row down one line rather than sending it to the end of the book.
      return { parentId: null, index: parentPosition + 1 }
    }
  }
}
