import { describe, it, expect } from 'vitest'
import { keyBetween, keyForIndex } from './ordering.js'

/**
 * Fractional ordering, shared by the storyboard and the binder.
 *
 * `keyBetween` is also exercised through `beat.test.ts`, which predates this
 * file; what is tested here is the contract `keyForIndex` adds on top, because
 * that is the one a caller can get wrong silently.
 */

describe('keyBetween', () => {
  it('lands strictly between two neighbours', () => {
    const key = keyBetween(1, 2)
    expect(key).toBeGreaterThan(1)
    expect(key).toBeLessThan(2)
  })

  it('extends past either end', () => {
    expect(keyBetween(null, 0)).toBeLessThan(0)
    expect(keyBetween(0, null)).toBeGreaterThan(0)
  })

  it('starts somewhere when there is nothing to sit between', () => {
    expect(keyBetween(null, null)).toBe(0)
  })

  /*
   * Halving cannot run out in any realistic session, but it does converge — so
   * this records the property rather than pretending it is infinite. A binder
   * would need tens of thousands of drops onto the same gap to reach it.
   */
  it('keeps producing distinct keys over repeated subdivision', () => {
    let low = 0
    const high = 1
    const seen = new Set<number>()
    for (let i = 0; i < 40; i++) {
      const key = keyBetween(low, high)
      expect(seen.has(key)).toBe(false)
      seen.add(key)
      low = key
    }
  })
})

describe('keyForIndex', () => {
  const siblings = [{ order: 0 }, { order: 1 }, { order: 2 }]

  it('places before, between and after', () => {
    expect(keyForIndex(siblings, 0)).toBeLessThan(0)
    expect(keyForIndex(siblings, 1)).toBeGreaterThan(0)
    expect(keyForIndex(siblings, 1)).toBeLessThan(1)
    expect(keyForIndex(siblings, 3)).toBeGreaterThan(2)
  })

  it('clamps rather than reading past either end', () => {
    expect(keyForIndex(siblings, 99)).toBeGreaterThan(2)
    expect(keyForIndex(siblings, -3)).toBeLessThan(0)
  })

  it('handles an empty list', () => {
    expect(keyForIndex([], 0)).toBe(0)
  })

  /*
   * The contract this helper cannot enforce, recorded so it is at least
   * written down: the moving item must already be out of `siblings`. Left in,
   * an item dragged one place down computes the slot it is already in and the
   * drag appears to do nothing. `placeInManuscript` and `placeInColumn` are the
   * two callers, and both filter first.
   */
  it('reads indices against the list it is given, moving item excluded by the caller', () => {
    const all = [{ order: 0 }, { order: 1 }, { order: 2 }]
    // Moving the first item to "between the other two" — the caller drops it.
    const withoutMover = all.slice(1)
    const key = keyForIndex(withoutMover, 1)
    expect(key).toBeGreaterThan(1)
    expect(key).toBeLessThan(2)
  })
})
