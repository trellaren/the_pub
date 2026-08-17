import { describe, it, expect } from 'vitest'
import { resolvePdfHighlight } from './pdfAnchor.js'

describe('resolvePdfHighlight', () => {
  it('trusts the stored page when the quote is found there', () => {
    const result = resolvePdfHighlight(
      { quote: 'the quick brown fox', page: 2 },
      [
        { page: 1, text: 'irrelevant' },
        { page: 2, text: 'saw the quick brown fox jump' }
      ]
    )
    expect(result).toEqual({ page: 2, byQuote: true })
  })

  /*
   * The load-bearing case: a re-scanned or re-paginated source shifted the
   * quote off its originally recorded page. The quote wins over the stored
   * page/rects, per `docs/phase-11-plan.md`'s "quote first, rects second".
   */
  it('follows the quote to a different page when stored page and quote disagree', () => {
    const result = resolvePdfHighlight(
      { quote: 'the quick brown fox', page: 2 },
      [
        { page: 1, text: 'nothing here' },
        { page: 2, text: 'still nothing' },
        { page: 3, text: 'saw the quick brown fox jump' }
      ]
    )
    expect(result).toEqual({ page: 3, byQuote: true })
  })

  it('falls back to the stored page, unverified, when the quote is nowhere to be found', () => {
    const result = resolvePdfHighlight(
      { quote: 'text that no longer exists anywhere', page: 2 },
      [
        { page: 1, text: 'irrelevant' },
        { page: 2, text: 'also irrelevant' }
      ]
    )
    expect(result).toEqual({ page: 2, byQuote: false })
  })

  it('returns null when neither the quote nor the stored page can be found', () => {
    const result = resolvePdfHighlight(
      { quote: 'text that no longer exists anywhere', page: 7 },
      [{ page: 1, text: 'irrelevant' }]
    )
    expect(result).toBeNull()
  })

  it('treats an empty quote as unverifiable and falls back to the stored page', () => {
    const result = resolvePdfHighlight({ quote: '   ', page: 1 }, [{ page: 1, text: 'anything' }])
    expect(result).toEqual({ page: 1, byQuote: false })
  })
})
