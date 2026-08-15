/**
 * Fractional ordering, shared by everything that can be dragged.
 *
 * Lifted out of `beat.ts` when the manuscript binder needed the same thing:
 * the storyboard orders cards within a column, and the binder orders chapters
 * within a part, and those are the same problem seen twice. `beat.ts` re-exports
 * this so nothing that already imported it from there had to change.
 */

/**
 * A sort key that lands between two neighbours.
 *
 * Fractional keys mean a drag rewrites one record instead of renumbering every
 * sibling after it — which matters because each rewrite is a file write and a
 * re-render.
 *
 * Keys only ever need to be comparable *among siblings*. Nothing compares a key
 * from one parent against a key from another, because ordering is only ever
 * asked "where does this go among its brothers" — which is what lets the same
 * helper serve a flat column and a nested tree without knowing which it is in.
 */
export function keyBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0
  if (before === null) return after! - 1
  if (after === null) return before + 1
  return (before + after) / 2
}

/**
 * The key for something dropped at `index` among `siblings`.
 *
 * `index` counts positions in the list as it looks *without* the moving item,
 * which is what a drop indicator between two rows means. Callers must therefore
 * remove the moving item before calling — getting that wrong is what produces
 * the classic "drag down by one does nothing", because the item's own position
 * shifts the count by one under it.
 */
export function keyForIndex(siblings: readonly { order: number }[], index: number): number {
  const clamped = Math.max(0, Math.min(index, siblings.length))
  const before = clamped > 0 ? siblings[clamped - 1]!.order : null
  const after = clamped < siblings.length ? siblings[clamped]!.order : null
  return keyBetween(before, after)
}
