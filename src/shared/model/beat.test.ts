import { describe, it, expect } from 'vitest'
import {
  beatSchema,
  beatFileSchema,
  parseMoment,
  keyBetween,
  beatsInColumn,
  beatsInChronology,
  placeInColumn,
  placeInChronology,
  type Beat
} from './beat.js'

function beat(patch: Partial<Beat> & { id: string }): Beat {
  return beatSchema.parse({
    title: patch.id,
    columnId: 'act-1',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...patch
  })
}

describe('beatSchema', () => {
  it('fills in the defaults a new beat needs', () => {
    const parsed = beat({ id: 'b1' })
    expect(parsed.when).toEqual({ label: '', sort: null })
    expect(parsed.entityIds).toEqual([])
    expect(parsed.status).toBe('outline')
    expect(parsed.docId).toBeNull()
  })

  it('gives each parse its own entity list', () => {
    expect(beat({ id: 'b1' }).entityIds).not.toBe(beat({ id: 'b2' }).entityIds)
  })
})

describe('beatFileSchema', () => {
  it('seeds three acts rather than an empty board', () => {
    const file = beatFileSchema.parse({})
    expect(file.columns.map((column) => column.name)).toEqual(['Act I', 'Act II', 'Act III'])
    expect(file.beats).toEqual([])
  })

  it('gives each parse its own columns', () => {
    expect(beatFileSchema.parse({}).columns).not.toBe(beatFileSchema.parse({}).columns)
  })
})

describe('parseMoment', () => {
  it('reads a real date as its instant', () => {
    expect(parseMoment('1917-04-02')).toBe(Date.parse('1917-04-02'))
  })

  it('reads a label with exactly one number', () => {
    expect(parseMoment('Day 3')).toBe(3)
    expect(parseMoment('Year 12')).toBe(12)
    expect(parseMoment('  7 ')).toBe(7)
    expect(parseMoment('Chapter -2')).toBe(-2)
  })

  it('declines anything ambiguous rather than guessing', () => {
    // A wrong key silently reorders someone's story; no key just leaves it put.
    expect(parseMoment('Day 3, Year 12')).toBeNull()
    expect(parseMoment('Midsummer')).toBeNull()
    expect(parseMoment('')).toBeNull()
    expect(parseMoment('   ')).toBeNull()
  })

  it('orders invented calendars sensibly when they carry one number', () => {
    expect(parseMoment('Third Age 2941')).toBeLessThan(parseMoment('Third Age 3019')!)
  })
})

describe('keyBetween', () => {
  it('lands between two neighbours', () => {
    expect(keyBetween(0, 1)).toBe(0.5)
    expect(keyBetween(0.5, 1)).toBe(0.75)
  })

  it('extends past either end', () => {
    expect(keyBetween(4, null)).toBe(5)
    expect(keyBetween(null, 4)).toBe(3)
    expect(keyBetween(null, null)).toBe(0)
  })
})

describe('ordering', () => {
  const beats = [
    beat({ id: 'c', columnId: 'act-1', order: 2, when: { label: 'Day 1', sort: 1 } }),
    beat({ id: 'a', columnId: 'act-1', order: 0, when: { label: 'Day 9', sort: 9 } }),
    beat({ id: 'b', columnId: 'act-2', order: 1, when: { label: '', sort: null } })
  ]

  it('orders a column by its own positions', () => {
    expect(beatsInColumn(beats, 'act-1').map((item) => item.id)).toEqual(['a', 'c'])
    expect(beatsInColumn(beats, 'act-2').map((item) => item.id)).toEqual(['b'])
  })

  it('orders chronologically, with undated beats last', () => {
    // 'a' is later in the manuscript but earlier in the story: that difference
    // is the whole reason both views exist.
    expect(beatsInChronology(beats).map((item) => item.id)).toEqual(['c', 'a', 'b'])
  })

  it('breaks ties without reshuffling on every render', () => {
    const tied = [beat({ id: 'y', order: 0 }), beat({ id: 'x', order: 0 })]
    expect(beatsInColumn(tied, 'act-1').map((item) => item.id)).toEqual(['x', 'y'])
    expect(beatsInColumn([...tied].reverse(), 'act-1').map((item) => item.id)).toEqual(['x', 'y'])
  })
})

describe('placeInColumn', () => {
  const beats = [
    beat({ id: 'a', order: 0 }),
    beat({ id: 'b', order: 1 }),
    beat({ id: 'c', order: 2 })
  ]

  it('drops between two cards without renumbering the rest', () => {
    const placed = placeInColumn(beats, 'c', 'act-1', 1)
    expect(placed).toEqual({ columnId: 'act-1', order: 0.5 })
    const moved = beats.map((item) => (item.id === 'c' ? { ...item, ...placed } : item))
    expect(beatsInColumn(moved, 'act-1').map((item) => item.id)).toEqual(['a', 'c', 'b'])
  })

  it('drops at either end', () => {
    expect(placeInColumn(beats, 'c', 'act-1', 0).order).toBe(-1)
    expect(placeInColumn(beats, 'a', 'act-1', 3).order).toBe(3)
  })

  it('ignores the moving beat when reading its neighbours', () => {
    // Dropping 'b' where it already is must not compute a key against itself.
    expect(placeInColumn(beats, 'b', 'act-1', 1).order).toBe(1)
  })

  it('moves a beat into an empty column', () => {
    expect(placeInColumn(beats, 'a', 'act-3', 0)).toEqual({ columnId: 'act-3', order: 0 })
  })

  it('clamps an index past the end', () => {
    expect(placeInColumn(beats, 'a', 'act-1', 99).order).toBe(2 + 1)
  })
})

describe('placeInChronology', () => {
  const beats = [
    beat({ id: 'a', when: { label: 'Day 1', sort: 1 } }),
    beat({ id: 'b', when: { label: 'Day 5', sort: 5 } }),
    beat({ id: 'c', when: { label: '', sort: null } })
  ]

  it('dates a beat dropped between two dated ones', () => {
    expect(placeInChronology(beats, 'c', 1)).toBe(3)
  })

  it('leaves a beat dropped among the undated undated', () => {
    expect(placeInChronology(beats, 'a', 3)).toBeNull()
  })

  it('dates a beat dropped before the first', () => {
    expect(placeInChronology(beats, 'c', 0)).toBe(0)
  })
})
