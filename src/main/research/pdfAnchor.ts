import type { PdfHighlight } from '../../shared/model/research.js'

/**
 * Where a PDF highlight resolves to when re-opening the document: quoted
 * text first, the stored page/rects only as a fallback — the ordering
 * `docs/phase-11-plan.md` calls out explicitly, because page coordinates are
 * exact and brittle (they break the moment a source is replaced by a
 * different scan of the same paper) while quoted text survives.
 *
 * `pageText` is per-page plain text extracted by pdf.js for the page the
 * highlight was originally recorded on, plus (when available) the page
 * before and after — a re-scanned or re-paginated PDF can shift a quote by a
 * page, and refusing to look one page either side would orphan highlights
 * that a person can plainly see are still there.
 */
export interface PdfAnchorCandidate {
  page: number
  text: string
}

export interface PdfAnchorResult {
  page: number
  /** True when the quote was found by text search rather than trusted from the stored page/rects. */
  byQuote: boolean
}

/**
 * Resolve `highlight` against the pages currently in the document.
 *
 * When the quote is found on a page other than the one stored, the quote
 * wins and the highlight is *not* orphaned — this is the "quote first, rects
 * second" rule applied at recovery time, not just at capture time. Only when
 * the quote cannot be found anywhere in `candidates` does the stored page
 * stand, unverified, and the caller decides whether that counts as orphaned.
 */
export function resolvePdfHighlight(
  highlight: Pick<PdfHighlight, 'quote' | 'page'>,
  candidates: PdfAnchorCandidate[]
): PdfAnchorResult | null {
  const needle = highlight.quote.trim()
  if (needle) {
    const byQuote = candidates.find((candidate) => candidate.text.includes(needle))
    if (byQuote) return { page: byQuote.page, byQuote: true }
  }
  const stillOnStoredPage = candidates.some((candidate) => candidate.page === highlight.page)
  if (stillOnStoredPage) return { page: highlight.page, byQuote: false }
  return null
}
