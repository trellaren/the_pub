import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEME_OPTIONS } from './settings/registry.js'
import { AAA_THEMES, DEFAULT_THEME } from './themes.js'

/**
 * WCAG 2.1 contrast checking over every theme's actual CSS tokens.
 *
 * Reads `renderer/styles.css` directly rather than duplicating hex values
 * here, so this test can never drift from what the app actually paints —
 * the same "make the rule the suite enforces" move `toDocx.test.ts`'s
 * closed-world test makes for node/mark types.
 */

const CSS_PATH = fileURLToPath(new URL('../renderer/styles.css', import.meta.url))

function parseThemeBlocks(css: string): Map<string, Record<string, string>> {
  const themes = new Map<string, Record<string, string>>()

  // The default theme has no [data-theme] block: it is `@theme` itself, which
  // is what an unstamped document paints.
  const defaultBlock = css.match(/@theme\s*\{([^}]*)\}/)
  if (defaultBlock) themes.set(DEFAULT_THEME, parseTokens(defaultBlock[1]))

  const blockPattern = /\[data-theme=(['"])([\w-]+)\1\]\s*\{([^}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = blockPattern.exec(css))) {
    themes.set(match[2], parseTokens(match[3]))
  }
  return themes
}

function parseTokens(block: string): Record<string, string> {
  const tokens: Record<string, string> = {}
  const tokenPattern = /--color-([\w-]+):\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3});/g
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(block))) {
    tokens[match[1]] = match[2]
  }
  return tokens
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.slice(1)
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const num = Number.parseInt(h, 16)
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const [rl, gl, bl] = [channel(r), channel(g), channel(b)]
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl
}

/** WCAG contrast ratio between two hex colours, in [1, 21]. */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexToRgb(hexA))
  const lb = relativeLuminance(hexToRgb(hexB))
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la]
  return (lighter + 0.05) / (darker + 0.05)
}

const css = readFileSync(CSS_PATH, 'utf8')
const themes = parseThemeBlocks(css)

// AA normal text (4.5:1) for text-on-surface pairs; AA non-text/UI (3:1) for
// accent used as an interactive foreground against its usual backgrounds.
const TEXT_PAIRS: Array<[string, string]> = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surface-2'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['paper-ink', 'paper']
]
const UI_PAIRS: Array<[string, string]> = [
  ['accent', 'bg'],
  ['accent', 'surface']
]

/**
 * A theme the registry marks `contrast: 'aaa'` promises more than the AA floor,
 * and this is where that promise is kept: AAA text, AA-sized accent, and a
 * border that is a line rather than a shade — which is the difference someone
 * who reaches for a high-contrast theme is actually reaching for.
 */
const AAA_PAIRS: Array<[string, string]> = [...TEXT_PAIRS, ['border', 'surface'], ['border', 'bg']]

describe('theme contrast (WCAG AA)', () => {
  /*
   * Every registered theme has a palette, and every palette is a registered
   * theme. A block left in the stylesheet after its id was renamed is dead
   * paint no one can select; a theme registered without one silently falls back
   * to the default's colours while claiming to be its own.
   */
  it('paints exactly the themes the registry offers', () => {
    expect([...themes.keys()].sort()).toEqual(THEME_OPTIONS.map((option) => option.value).sort())
  })

  for (const [id, tokens] of themes) {
    const aaa = AAA_THEMES.has(id as (typeof THEME_OPTIONS)[number]['value'])

    describe(`theme "${id}"`, () => {
      for (const [fg, bg] of TEXT_PAIRS) {
        it(`${fg} on ${bg} is at least 4.5:1`, () => {
          const fgHex = tokens[fg]
          const bgHex = tokens[bg]
          expect(fgHex, `missing --color-${fg}`).toBeDefined()
          expect(bgHex, `missing --color-${bg}`).toBeDefined()
          const ratio = contrastRatio(fgHex, bgHex)
          expect(ratio).toBeGreaterThanOrEqual(4.5)
        })
      }
      for (const [fg, bg] of UI_PAIRS) {
        it(`${fg} on ${bg} is at least 3:1`, () => {
          const fgHex = tokens[fg]
          const bgHex = tokens[bg]
          expect(fgHex, `missing --color-${fg}`).toBeDefined()
          expect(bgHex, `missing --color-${bg}`).toBeDefined()
          const ratio = contrastRatio(fgHex, bgHex)
          expect(ratio).toBeGreaterThanOrEqual(3)
        })
      }

      if (!aaa) return
      for (const [fg, bg] of AAA_PAIRS) {
        it(`${fg} on ${bg} reaches AAA (7:1)`, () => {
          expect(contrastRatio(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(7)
        })
      }
      for (const [fg, bg] of UI_PAIRS) {
        it(`${fg} on ${bg} reaches 4.5:1`, () => {
          expect(contrastRatio(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(4.5)
        })
      }
    })
  }
})
