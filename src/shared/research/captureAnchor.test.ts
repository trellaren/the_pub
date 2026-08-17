import { describe, it, expect } from 'vitest'
import { resolveCaptureHighlight } from './captureAnchor.js'

describe('resolveCaptureHighlight', () => {
  const text = 'The quick brown fox jumps over the lazy dog.'

  it('trusts the stored offset when the quote is still there', () => {
    const result = resolveCaptureHighlight({ quote: 'quick brown fox', offset: 4 }, text)
    expect(result).toEqual({ offset: 4, length: 'quick brown fox'.length })
  })

  /*
   * Captures are immutable once fetched (`docs/phase-11-plan.md`'s "no
   * full-page archive"), so this only matters when the offset was never
   * recorded (`-1`, e.g. migrated data) — the quote search still has to work.
   */
  it('falls back to a text search when the stored offset is unknown', () => {
    const result = resolveCaptureHighlight({ quote: 'lazy dog', offset: -1 }, text)
    expect(result).toEqual({ offset: text.indexOf('lazy dog'), length: 'lazy dog'.length })
  })

  it('falls back to a text search when the stored offset no longer matches', () => {
    const result = resolveCaptureHighlight({ quote: 'lazy dog', offset: 0 }, text)
    expect(result).toEqual({ offset: text.indexOf('lazy dog'), length: 'lazy dog'.length })
  })

  it('returns null when the quote cannot be found anywhere', () => {
    const result = resolveCaptureHighlight({ quote: 'a phrase never in the text', offset: -1 }, text)
    expect(result).toBeNull()
  })

  it('returns null for an empty quote', () => {
    const result = resolveCaptureHighlight({ quote: '', offset: -1 }, text)
    expect(result).toBeNull()
  })
})
