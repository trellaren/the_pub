import { describe, it, expect } from 'vitest'
import { diffSequences, type DiffOp } from './lcsDiff.js'

/**
 * The diff underneath both granularities.
 *
 * Most of these assert the reconstruction property rather than an exact op
 * list: several op sequences can be equally minimal, and pinning one of them
 * would be testing this implementation's tie-breaking rather than its
 * correctness. Where the exact shape does matter — a pure insert staying one
 * op, a run coalescing — it is asserted directly.
 */

/** Applying the ops to `a` must produce `b`; anything else is not a diff. */
function rebuild<T>(ops: readonly DiffOp<T>[]): T[] {
  return ops.filter((op) => op.type !== 'delete').flatMap((op) => op.items)
}

/** And the deletions plus the equalities must account for all of `a`. */
function original<T>(ops: readonly DiffOp<T>[]): T[] {
  return ops.filter((op) => op.type !== 'insert').flatMap((op) => op.items)
}

const words = (text: string): string[] => text.split(' ')

describe('diffSequences', () => {
  it('has nothing to say about two empty sequences', () => {
    expect(diffSequences([], [])).toEqual([])
  })

  it('reports an identical sequence as one equal run', () => {
    expect(diffSequences(words('a b c'), words('a b c'))).toEqual([
      { type: 'equal', items: ['a', 'b', 'c'] }
    ])
  })

  it('reports a pure insert and a pure delete as one op each', () => {
    expect(diffSequences([], words('a b'))).toEqual([{ type: 'insert', items: ['a', 'b'] }])
    expect(diffSequences(words('a b'), [])).toEqual([{ type: 'delete', items: ['a', 'b'] }])
  })

  it('finds an insertion in the middle', () => {
    const ops = diffSequences(words('the storm broke'), words('the great storm broke'))
    expect(rebuild(ops)).toEqual(words('the great storm broke'))
    expect(original(ops)).toEqual(words('the storm broke'))
    expect(ops.filter((op) => op.type === 'insert')).toEqual([{ type: 'insert', items: ['great'] }])
  })

  it('finds a deletion in the middle', () => {
    const ops = diffSequences(words('the great storm broke'), words('the storm broke'))
    expect(rebuild(ops)).toEqual(words('the storm broke'))
    expect(ops.filter((op) => op.type === 'delete')).toEqual([{ type: 'delete', items: ['great'] }])
  })

  it('handles edits interleaved through a sequence', () => {
    const ops = diffSequences(words('a b c d e'), words('a x c y e'))
    expect(rebuild(ops)).toEqual(words('a x c y e'))
    expect(original(ops)).toEqual(words('a b c d e'))
  })

  it('reports a wholesale replacement without pretending anything matched', () => {
    const ops = diffSequences(words('a b'), words('x y'))
    expect(rebuild(ops)).toEqual(words('x y'))
    expect(ops.some((op) => op.type === 'equal')).toBe(false)
  })

  /* Adjacent changes of one kind are one change, not several — a rewritten
   * sentence should read as a rewritten sentence. */
  it('coalesces a run of edits into single ops', () => {
    const ops = diffSequences(words('a b c d'), words('a x y z'))
    expect(ops.filter((op) => op.type === 'delete')).toHaveLength(1)
    expect(ops.filter((op) => op.type === 'insert')).toHaveLength(1)
  })

  it('honours a caller’s notion of equality', () => {
    const ops = diffSequences(['A', 'B'], ['a', 'b'], (x, y) => x.toLowerCase() === y.toLowerCase())
    expect(ops).toEqual([{ type: 'equal', items: ['A', 'B'] }])
  })

  it('finds the minimal edit rather than replacing wholesale', () => {
    // Anything longer means the algorithm is not doing its job; the answer here
    // is one deletion and one insertion.
    const ops = diffSequences(words('a b c d e f'), words('a b x d e f'))
    expect(ops.filter((op) => op.type !== 'equal')).toHaveLength(2)
  })

  /*
   * Reconstruction over a hundred varied cases, which is the property that
   * actually matters and the one an exact-op-list test cannot cover. The
   * sequences are derived rather than random: the tests have to say the same
   * thing on every run.
   */
  it('always reconstructs the target, over many shapes', () => {
    for (let seed = 0; seed < 100; seed++) {
      const a = Array.from({ length: 12 }, (_unused, i) => (i * seed) % 7)
      const b = Array.from({ length: 10 }, (_unused, i) => (i * (seed + 3)) % 5)
      const ops = diffSequences(a, b)
      expect(rebuild(ops)).toEqual(b)
      expect(original(ops)).toEqual(a)
    }
  })

  it('copes with a long shared prefix and suffix around one change', () => {
    const prefix = Array.from({ length: 200 }, (_unused, i) => `p${i}`)
    const suffix = Array.from({ length: 200 }, (_unused, i) => `s${i}`)
    const ops = diffSequences([...prefix, 'old', ...suffix], [...prefix, 'new', ...suffix])
    expect(ops.filter((op) => op.type !== 'equal')).toEqual([
      { type: 'delete', items: ['old'] },
      { type: 'insert', items: ['new'] }
    ])
  })
})
