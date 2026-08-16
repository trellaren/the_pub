import type { PmDoc, PmNode } from '../model/document.js'
import type { NamedStyle, Numbering } from '../model/style.js'
import { resolveStyle } from '../model/style.js'

/** A heading block's outline level (1-6), or `null` if it isn't one. Shared
 *  by the TOC builder and heading-number computation so the two never
 *  disagree about which blocks count as headings. */
export function outlineLevelOf(node: PmNode, styles: NamedStyle[]): number | null {
  const styleId = typeof node.attrs?.styleId === 'string' ? node.attrs.styleId : null
  if (styleId) {
    const resolved = resolveStyle(styleId, styles)
    const level = resolved?.outlineLevel ?? resolved?.headingLevel
    if (level !== undefined) return level
  }
  if (node.type === 'heading') {
    const level = node.attrs?.level
    if (typeof level === 'number') return level
  }
  return null
}

/**
 * "1.2.3" for every numbered heading, keyed by top-level block index.
 *
 * Numbers are computed, never stored — the same decision Phase 3 made for
 * footnote numbering (`extensions/footnote.ts`), and for the same reason: a
 * stored number is wrong the instant a heading is inserted above it.
 *
 * Each outline level's numbering configuration lives on whichever style
 * declares that level (a project's `heading-2` style, say) — read directly
 * off the style, not through `basedOn` inheritance, since numbering is a
 * level property, not something a child style should silently pick up. A
 * level with no style declaring numbering for it renders unnumbered, but
 * still resets any deeper counters when it appears, since it still starts a
 * new subsection. A level skipped entirely (an `<h3>` directly under an
 * `<h1>`, with no intervening `<h2>`) falls back to that level's own
 * `startAt` (or 1, if the level has no numbering configured at all) for any
 * `%n` token that references it — deterministic, and not a state that
 * depends on document history elsewhere.
 */
export function computeHeadingNumbers(doc: PmDoc, styles: NamedStyle[]): Map<number, string> {
  const byLevel = new Map<number, Numbering>()
  for (const style of styles) {
    const level = style.outlineLevel ?? style.headingLevel
    if (level !== undefined && style.numbering) byLevel.set(level, style.numbering)
  }

  const content = doc.content ?? []
  const counters = new Map<number, number>()
  const result = new Map<number, string>()

  for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
    const node = content[blockIndex]!
    const level = outlineLevelOf(node, styles)
    if (level === null) continue

    for (const seenLevel of [...counters.keys()]) {
      if (seenLevel > level) counters.delete(seenLevel)
    }

    const numbering = byLevel.get(level)
    if (!numbering) continue

    const next = (counters.get(level) ?? numbering.startAt - 1) + 1
    counters.set(level, next)
    result.set(blockIndex, renderLevelText(numbering.levelText, counters, byLevel))
  }

  return result
}

function renderLevelText(levelText: string, counters: Map<number, number>, byLevel: Map<number, Numbering>): string {
  return levelText.replace(/%(\d)/g, (_match, digits: string) => {
    const level = Number(digits)
    const numbering = byLevel.get(level)
    const count = counters.get(level) ?? numbering?.startAt ?? 1
    return formatCounter(count, numbering?.format ?? 'decimal')
  })
}

function formatCounter(n: number, format: Numbering['format']): string {
  switch (format) {
    case 'decimal':
      return String(n)
    case 'upper-roman':
      return toRoman(n)
    case 'lower-roman':
      return toRoman(n).toLowerCase()
    case 'upper-alpha':
      return toAlpha(n)
    case 'lower-alpha':
      return toAlpha(n).toLowerCase()
  }
}

const ROMAN_TABLE: Array<[number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I']
]

function toRoman(n: number): string {
  if (n <= 0) return String(n)
  let remaining = n
  let result = ''
  for (const [value, symbol] of ROMAN_TABLE) {
    while (remaining >= value) {
      result += symbol
      remaining -= value
    }
  }
  return result
}

/** Spreadsheet-column style: 1 → A, 26 → Z, 27 → AA. */
function toAlpha(n: number): string {
  if (n <= 0) return String(n)
  let remaining = n
  let result = ''
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    remaining = Math.floor((remaining - 1) / 26)
  }
  return result
}
