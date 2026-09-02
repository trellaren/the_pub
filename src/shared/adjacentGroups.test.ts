import { describe, expect, it } from 'vitest'
import { groupAdjacent } from './adjacentGroups.js'

const named = (group: string | undefined, ...labels: string[]): Array<{ label: string; group?: string }> =>
  labels.map((label) => ({ label, group }))

describe('groupAdjacent', () => {
  it('runs neighbours sharing a group together, in the order given', () => {
    const items = [...named('Raven', 'a', 'b'), ...named('Professional', 'c')]
    expect(groupAdjacent(items, (item) => item.group)).toEqual([
      { group: 'Raven', items: items.slice(0, 2) },
      { group: 'Professional', items: items.slice(2) }
    ])
  })

  it('keeps a list that names no group as one run', () => {
    const items = named(undefined, 'a', 'b', 'c')
    expect(groupAdjacent(items, (item) => item.group)).toEqual([{ group: undefined, items }])
  })

  /*
   * The point of grouping *adjacent* items: a group written in two places is
   * shown in two places rather than silently reordered into one, so the list
   * the reader sees is the list the registry states.
   */
  it('does not gather a group that was written in two places', () => {
    const items = [...named('A', 'a'), ...named('B', 'b'), ...named('A', 'c')]
    expect(groupAdjacent(items, (item) => item.group).map((run) => run.group)).toEqual(['A', 'B', 'A'])
  })

  it('returns nothing for nothing', () => {
    expect(groupAdjacent([], () => undefined)).toEqual([])
  })
})
