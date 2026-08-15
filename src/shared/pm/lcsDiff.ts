/**
 * The one diff algorithm everything else here is built on.
 *
 * Myers, over any two sequences and any notion of equality — blocks of prose at
 * one level, words within a block at the other. Owning it rather than depending
 * on a library follows the same reasoning as `ordering.ts` and `ftpDates.ts`:
 * it is fifty lines, it is exactly testable, and a diff that renders someone's
 * revisions is not somewhere to inherit surprises.
 *
 * O(ND) in the edit distance, which is the point — two versions of a chapter
 * are mostly the same chapter, so D is small even when N is not. It is never
 * run across a whole manuscript at once.
 */

export type DiffOpType = 'equal' | 'delete' | 'insert'

export interface DiffOp<T> {
  type: DiffOpType
  items: T[]
}

export function diffSequences<T>(
  a: readonly T[],
  b: readonly T[],
  equal: (x: T, y: T) => boolean = (x, y) => x === y
): DiffOp<T>[] {
  // The cheap answers first: both are common in practice — an untouched
  // paragraph, a version with everything added or everything cut.
  if (a.length === 0 && b.length === 0) return []
  if (a.length === 0) return [{ type: 'insert', items: [...b] }]
  if (b.length === 0) return [{ type: 'delete', items: [...a] }]

  const trace = buildTrace(a, b, equal)
  return coalesce(walkBack(trace, a, b))
}

/**
 * One furthest-reaching frontier per edit distance, kept so the path can be
 * recovered afterwards. `v[k]` is how far along `a` a path of the current
 * distance has reached on diagonal `k`.
 */
function buildTrace<T>(
  a: readonly T[],
  b: readonly T[],
  equal: (x: T, y: T) => boolean
): Map<number, number>[] {
  const max = a.length + b.length
  const v = new Map<number, number>([[1, 0]])
  const trace: Map<number, number>[] = []

  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      // Step down (an insertion) when there is no left neighbour to come from,
      // or when the one below reaches further than the one to the left.
      const down = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1
      let y = x - k
      // Then run out the diagonal: matching items are free.
      while (x < a.length && y < b.length && equal(a[x]!, b[y]!)) {
        x++
        y++
      }
      v.set(k, x)
      if (x >= a.length && y >= b.length) return trace
    }
  }
  return trace
}

/** Walk the trace backwards, emitting one op per step, then reverse. */
function walkBack<T>(trace: Map<number, number>[], a: readonly T[], b: readonly T[]): DiffOp<T>[] {
  const ops: DiffOp<T>[] = []
  let x = a.length
  let y = b.length

  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d]!
    const k = x - y
    const down = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))
    const previousK = down ? k + 1 : k - 1
    const previousX = v.get(previousK) ?? 0
    const previousY = previousX - previousK

    while (x > previousX && y > previousY) {
      ops.push({ type: 'equal', items: [a[x - 1]!] })
      x--
      y--
    }
    if (down) {
      ops.push({ type: 'insert', items: [b[y - 1]!] })
      y--
    } else {
      ops.push({ type: 'delete', items: [a[x - 1]!] })
      x--
    }
  }

  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', items: [a[x - 1]!] })
    x--
    y--
  }
  while (x > 0) {
    ops.push({ type: 'delete', items: [a[--x]!] })
  }
  while (y > 0) {
    ops.push({ type: 'insert', items: [b[--y]!] })
  }

  return ops.reverse()
}

/** Merge neighbouring ops of the same kind, so a run reads as one change. */
function coalesce<T>(ops: readonly DiffOp<T>[]): DiffOp<T>[] {
  const merged: DiffOp<T>[] = []
  for (const op of ops) {
    const last = merged.at(-1)
    if (last && last.type === op.type) last.items.push(...op.items)
    else merged.push({ type: op.type, items: [...op.items] })
  }
  return merged
}
