/**
 * Where a capture highlight resolves to when re-opening the capture: the
 * quoted text's offset in the capture's stored plain text.
 *
 * A capture is fetched once and stored as immutable text (`Capture.text`,
 * `docs/phase-11-plan.md`'s "no full-page archive") — there is no re-scan, no
 * re-pagination, and no coordinate system to disagree with the quote the way
 * a PDF's page/rects can. That makes this strictly simpler than
 * `pdfAnchor.ts`'s quote-first-over-rects reconciliation: the quote is either
 * still a substring of the unchanged text, or the highlight is orphaned.
 * Pure and shared (not main-only like `pdfAnchor.ts`) because the capture
 * viewer needs the same offset math in the renderer to place `<mark>`s.
 */
export interface CaptureAnchorResult {
  offset: number
  length: number
}

/** Resolve `quote` against `text`, preferring the stored `offset` when the text there still matches. */
export function resolveCaptureHighlight(
  highlight: { quote: string; offset: number },
  text: string
): CaptureAnchorResult | null {
  const needle = highlight.quote
  if (!needle) return null

  if (
    highlight.offset >= 0 &&
    text.slice(highlight.offset, highlight.offset + needle.length) === needle
  ) {
    return { offset: highlight.offset, length: needle.length }
  }

  const found = text.indexOf(needle)
  if (found === -1) return null
  return { offset: found, length: needle.length }
}
