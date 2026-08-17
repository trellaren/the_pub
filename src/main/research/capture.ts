import type { Capture } from '../../shared/model/research.js'

/** The subset of `fetch` this module uses, so a test can supply one by hand — see `onedrive/graph.ts`. */
export type CaptureFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface CaptureResult {
  ok: true
  capture: Capture
}
export interface CaptureFailure {
  ok: false
  reason: 'offline' | 'not-found' | 'unreadable'
}

/**
 * Fetch `url` and extract quotable text and a title from it.
 *
 * Deliberately not a full-page archive (see `docs/phase-11-plan.md`): no
 * screenshot, no asset scan, just the readable text a citation's locator
 * could point a reader back to, plus the date it was captured — because a
 * "captured on" date the bibliography cannot see is a date that does not
 * exist.
 */
export async function capturePage(url: string, fetchImpl: CaptureFetch, now: () => Date = () => new Date()): Promise<CaptureResult | CaptureFailure> {
  let response: Awaited<ReturnType<CaptureFetch>>
  try {
    response = await fetchImpl(url)
  } catch {
    return { ok: false, reason: 'offline' }
  }
  if (!response.ok) {
    return { ok: false, reason: response.status === 404 ? 'not-found' : 'offline' }
  }

  const html = await response.text()
  const title = extractTitle(html) || url
  const text = extractReadableText(html)
  if (!text) return { ok: false, reason: 'unreadable' }

  const accessed = now().toISOString().slice(0, 10)
  return { ok: true, capture: { url, title, text, accessed } }
}

/** CSL `date-parts` for a `YYYY-MM-DD` capture date, ready to merge into a `CslItem`'s `accessed` field. */
export function accessedDateParts(accessed: string): number[] {
  return accessed.split('-').map((part) => Number(part))
}

/**
 * Merge a capture's `url` and `accessed` date into the CSL item's own
 * `URL`/`accessed` fields — the fields citeproc already renders, so a
 * capture's provenance shows up in a bibliography without any special-casing.
 */
export function applyCaptureToCslFields(url: string, accessed: string): { URL: string; accessed: { 'date-parts': number[][] } } {
  return { URL: url, accessed: { 'date-parts': [accessedDateParts(accessed)] } }
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match ? decodeEntities(match[1]!.trim()) : ''
}

/**
 * Strip script/style/nav/footer/header/aside blocks and tags, collapsing
 * whitespace — a heuristic reader-mode extraction, not an HTML parser. Good
 * enough for "quotable text with a date", which is the whole deliverable.
 */
function extractReadableText(html: string): string {
  const withoutNoise = html
    .replace(/<(script|style|nav|footer|header|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const withoutTags = withoutNoise.replace(/<[^>]+>/g, ' ')
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
