/**
 * Split a list into runs of neighbours that name the same group.
 *
 * Deliberately *adjacent* rather than a keyed group-by: the lists this serves —
 * the theme picker, the theme submenu — are already written in the order they
 * should be read, and a keyed group-by would quietly reorder them, or scatter
 * one group across the list if an entry moved. Here a run is exactly what the
 * author wrote next to itself; a list that names no groups at all comes back as
 * one ungrouped run, so a caller can render it exactly as before.
 */
export function groupAdjacent<T>(
  items: readonly T[],
  groupOf: (item: T) => string | undefined
): Array<{ group: string | undefined; items: T[] }> {
  const runs: Array<{ group: string | undefined; items: T[] }> = []
  for (const item of items) {
    const group = groupOf(item)
    const last = runs[runs.length - 1]
    if (last && last.group === group) last.items.push(item)
    else runs.push({ group, items: [item] })
  }
  return runs
}
