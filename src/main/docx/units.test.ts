import { describe, it, expect } from 'vitest'
import {
  pointsToTwips,
  twipsToPoints,
  pointsToHalfPoints,
  halfPointsToPoints,
  lineHeightToUnits,
  unitsToLineHeight,
  parsePointLength,
  formatPointLength,
  ooxmlColorToCss,
  cssColorToOoxml,
  toggleValue,
  attr,
  numAttr,
  asArray
} from './units.js'

describe('length conversions', () => {
  it('uses Word’s units, not points', () => {
    // A wrong constant here produces a document that opens perfectly and is
    // silently the wrong shape, which is the whole reason they live in one file.
    expect(pointsToTwips(12)).toBe(240)
    expect(pointsToHalfPoints(12)).toBe(24)
    expect(lineHeightToUnits(1.5)).toBe(360)
  })

  it('round-trips the sizes a manuscript actually uses', () => {
    for (const points of [0, 6, 8, 10, 11, 12, 14, 18, 24, 28, 36, 48, 72]) {
      expect(twipsToPoints(pointsToTwips(points))).toBe(points)
      expect(halfPointsToPoints(pointsToHalfPoints(points))).toBe(points)
    }
    for (const multiplier of [1, 1.15, 1.5, 1.6, 2, 2.5]) {
      expect(unitsToLineHeight(lineHeightToUnits(multiplier))).toBe(multiplier)
    }
  })

  it('rounds rather than leaving float noise in a saved document', () => {
    expect(twipsToPoints(241)).toBe(12.05)
    expect(halfPointsToPoints(23)).toBe(11.5)
  })
})

describe('parsePointLength', () => {
  it('reads the CSS string the textStyle mark stores', () => {
    expect(parsePointLength('12pt')).toBe(12)
    expect(parsePointLength(' 14pt ')).toBe(14)
    expect(parsePointLength(12)).toBe(12)
  })

  it('converts pixels, and reads a unitless number as points', () => {
    expect(parsePointLength('16px')).toBe(12)
    // CSS rejects a bare number for font-size, so one can only have come from
    // our own code — and every size this app writes is in points.
    expect(parsePointLength('16')).toBe(16)
  })

  it('declines anything it cannot read instead of guessing', () => {
    for (const value of ['', 'large', 'em', null, undefined, {}, '1.2.3pt']) {
      expect(parsePointLength(value)).toBeNull()
    }
  })

  it('agrees with formatPointLength both ways', () => {
    expect(parsePointLength(formatPointLength(11.5))).toBe(11.5)
    expect(formatPointLength(parsePointLength('18pt')!)).toBe('18pt')
  })
})

describe('colours', () => {
  it('adds and removes the hash Word does not use', () => {
    expect(ooxmlColorToCss('FF0000')).toBe('#ff0000')
    expect(cssColorToOoxml('#FF0000')).toBe('ff0000')
  })

  it('treats Word’s "auto" as no colour at all', () => {
    expect(ooxmlColorToCss('auto')).toBeNull()
    expect(ooxmlColorToCss(undefined)).toBeNull()
  })

  it('expands three-digit hex, which Word rejects', () => {
    expect(cssColorToOoxml('#f00')).toBe('ff0000')
  })

  it('reads the rgb() form a colour input can produce', () => {
    expect(cssColorToOoxml('rgb(255, 0, 128)')).toBe('ff0080')
    expect(cssColorToOoxml('rgba(0, 0, 0, 0.5)')).toBe('000000')
  })

  it('declines a colour it cannot express rather than emitting invalid XML', () => {
    expect(cssColorToOoxml('hotpink')).toBeNull()
    expect(ooxmlColorToCss('nonsense')).toBeNull()
  })
})

describe('toggleValue', () => {
  it('treats a bare element as on', () => {
    expect(toggleValue({})).toBe(true)
  })

  it('treats an explicit zero as off', () => {
    // Reading presence alone is the classic importer bug: it turns every
    // deliberately un-bolded run bold.
    expect(toggleValue({ '@_w:val': '0' })).toBe(false)
    expect(toggleValue({ '@_w:val': 'false' })).toBe(false)
    expect(toggleValue({ '@_w:val': 'off' })).toBe(false)
  })

  it('treats an explicit one as on', () => {
    expect(toggleValue({ '@_w:val': '1' })).toBe(true)
    expect(toggleValue({ '@_w:val': 'true' })).toBe(true)
  })

  it('treats an absent element as off', () => {
    expect(toggleValue(undefined)).toBe(false)
    expect(toggleValue(null)).toBe(false)
  })
})

describe('parser helpers', () => {
  it('reads attributes off whatever shape the parser produced', () => {
    expect(attr({ '@_w:val': 'center' }, 'w:val')).toBe('center')
    expect(attr({}, 'w:val')).toBeUndefined()
    expect(attr('text', 'w:val')).toBeUndefined()
    expect(numAttr({ '@_w:before': '240' }, 'w:before')).toBe(240)
    expect(numAttr({ '@_w:before': 'wide' }, 'w:before')).toBeNull()
  })

  it('normalises the one-or-many shape the parser returns for children', () => {
    expect(asArray(undefined)).toEqual([])
    expect(asArray('one')).toEqual(['one'])
    expect(asArray(['one', 'two'])).toEqual(['one', 'two'])
  })
})
