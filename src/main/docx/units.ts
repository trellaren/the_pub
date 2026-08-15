/**
 * The unit systems OOXML uses, and the ones The Pub uses.
 *
 * Word measures nothing in points. Paragraph spacing and indents are in twips
 * (a twentieth of a point), font sizes are in half-points, and line spacing is
 * in 240ths of a line. Getting one of these conversions wrong produces a
 * document that opens perfectly and is subtly the wrong shape, so every
 * conversion in the importer and exporter goes through this file and nowhere
 * else.
 */

/** Twentieths of a point — `w:spacing`, `w:ind`, `w:pgSz`, `w:pgMar`. */
export const TWIPS_PER_POINT = 20
/** `w:sz` and `w:szCs` are in half-points. */
export const HALF_POINTS_PER_POINT = 2
/** `w:spacing/@w:line` with `w:lineRule="auto"` is in 240ths of a line. */
export const LINE_UNITS_PER_LINE = 240

export function pointsToTwips(points: number): number {
  return Math.round(points * TWIPS_PER_POINT)
}

export function twipsToPoints(twips: number): number {
  return round2(twips / TWIPS_PER_POINT)
}

export function pointsToHalfPoints(points: number): number {
  return Math.round(points * HALF_POINTS_PER_POINT)
}

export function halfPointsToPoints(halfPoints: number): number {
  return round2(halfPoints / HALF_POINTS_PER_POINT)
}

export function lineHeightToUnits(multiplier: number): number {
  return Math.round(multiplier * LINE_UNITS_PER_LINE)
}

export function unitsToLineHeight(units: number): number {
  return round2(units / LINE_UNITS_PER_LINE)
}

/**
 * Points are fractional after a round trip through twips, and a raw float like
 * 11.999999999999998 in a saved document is noise nobody wants to read. Two
 * decimals is finer than any measurement Word's own UI exposes.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * The `textStyle` mark stores a CSS length string ("12pt"); `NamedStyle.text
 * .fontSize` stores a number of points. Both exist for good reasons — one is
 * rendered straight into a style attribute, the other is edited in a number
 * field — so the bridge between them lives here rather than being re-derived.
 */
export function parsePointLength(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const match = /^(-?\d+(?:\.\d+)?)\s*(pt|px)?$/.exec(value.trim())
  if (!match) return null
  const size = Number(match[1])
  if (!Number.isFinite(size)) return null
  // A unitless number is read as points, not pixels: CSS rejects a bare number
  // for font-size anyway, so one can only have come from our own code, and
  // every size this app writes is in points.
  return match[2] === 'px' ? round2(size * 0.75) : size
}

export function formatPointLength(points: number): string {
  return `${round2(points)}pt`
}

/**
 * OOXML colours are six hex digits with no `#`; CSS wants the hash. `auto` is
 * Word's "whatever the theme says", which is exactly what an absent colour
 * means here.
 */
export function ooxmlColorToCss(value: string | undefined): string | null {
  if (!value) return null
  const hex = value.trim().replace(/^#/, '')
  if (hex.toLowerCase() === 'auto') return null
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  return `#${hex.toLowerCase()}`
}

export function cssColorToOoxml(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  const short = /^#([0-9a-fA-F]{3})$/.exec(trimmed)
  // Word rejects three-digit hex, so expand rather than emit something invalid.
  if (short) {
    return short[1]!
      .split('')
      .map((digit) => digit + digit)
      .join('')
      .toLowerCase()
  }
  const long = /^#?([0-9a-fA-F]{6})$/.exec(trimmed)
  if (long) return long[1]!.toLowerCase()
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,[^)]*)?\)$/.exec(trimmed)
  if (rgb) {
    return [rgb[1], rgb[2], rgb[3]]
      .map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0'))
      .join('')
  }
  return null
}

/**
 * `w:b`, `w:i` and friends are toggle properties: present means on, but an
 * explicit `w:val="0"` means off. Treating presence alone as truth is the
 * classic importer bug — it turns every deliberately-disabled run bold.
 */
export function toggleValue(node: unknown): boolean {
  if (node === undefined || node === null) return false
  const value = attr(node, 'w:val')
  if (value === undefined) return true
  const normalized = String(value).toLowerCase()
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off'
}

/** Read an attribute from a `fast-xml-parser` node, whatever shape it arrived in. */
export function attr(node: unknown, name: string): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const value = (node as Record<string, unknown>)[`@_${name}`]
  return value === undefined || value === null ? undefined : String(value)
}

/** Read a numeric attribute, declining anything that is not a finite number. */
export function numAttr(node: unknown, name: string): number | null {
  const raw = attr(node, name)
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * `fast-xml-parser` gives a single child as an object and repeated children as
 * an array. Every caller wants a list, so normalise once here instead of
 * writing `Array.isArray(...) ? ... : [...]` at forty call sites.
 */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}
