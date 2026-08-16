import type { CslItem } from '../../shared/model/source.js'

/**
 * Fetching a source by identifier, from Crossref (DOI) and Open Library (ISBN).
 *
 * The mapping from each service's payload to CSL-JSON is a pure function,
 * separately exported and separately tested against captured responses — the
 * same split `onedrive/` uses to keep everything except the request itself
 * testable without a network. `lookupSource` is then a thin shell: build a
 * URL, parse JSON, map it.
 *
 * Every failure is a returned reason rather than a thrown error. Looking up a
 * DOI that turns out to be mistyped is an ordinary thing to do, and the panel
 * has to be able to say which of "no such record" and "could not reach the
 * service" happened — they call for different responses from the person.
 */
export type LookupResult =
  | { ok: true; item: CslItem }
  | { ok: false; reason: 'not-found' | 'offline' | 'malformed' | 'unsupported' }

/** Crossref asks callers to identify themselves; being anonymous gets throttled. */
const USER_AGENT = 'ThePub/0.1 (https://github.com/trellaren/the_pub)'
const TIMEOUT_MS = 10_000

/** A DOI with any of the prefixes people paste along with it removed. */
export function normalizeDoi(raw: string): string | null {
  const trimmed = raw.trim().replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
  return /^10\.\d{4,9}\/\S+$/.test(trimmed) ? trimmed : null
}

/** An ISBN-10 or ISBN-13 with its spacing and hyphens removed. */
export function normalizeIsbn(raw: string): string | null {
  const compact = raw.replace(/[\s-]/g, '').toUpperCase().replace(/^ISBN:?/, '')
  return /^(?:\d{9}[\dX]|\d{13})$/.test(compact) ? compact : null
}

/** Which kind of identifier this is, so one field can accept either. */
export function identify(raw: string): 'doi' | 'isbn' | null {
  if (normalizeDoi(raw)) return 'doi'
  if (normalizeIsbn(raw)) return 'isbn'
  return null
}

interface CrossrefName {
  family?: string
  given?: string
  name?: string
}

/**
 * Crossref's `message` object into a CSL item.
 *
 * Crossref is already CSL-adjacent — it uses `date-parts` and `container-title`
 * — but not identical: titles are arrays, and a corporate author arrives as
 * `name` where CSL wants `literal`.
 */
export function crossrefToCsl(message: Record<string, unknown>): CslItem | null {
  const doi = typeof message.DOI === 'string' ? message.DOI : null
  if (!doi) return null

  const firstString = (value: unknown): string | undefined => {
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
    return typeof value === 'string' ? value : undefined
  }

  const names = (value: unknown): CslItem['author'] | undefined => {
    if (!Array.isArray(value)) return undefined
    const mapped = (value as CrossrefName[]).map((entry) =>
      entry.family ? { family: entry.family, given: entry.given ?? '' } : { literal: entry.name ?? '' }
    )
    return mapped.length > 0 ? mapped : undefined
  }

  const issuedParts = (message.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']

  const item: CslItem = { id: doi, type: crossrefType(firstString(message.type)), DOI: doi }
  const title = firstString(message.title)
  if (title) item.title = title
  const container = firstString(message['container-title'])
  if (container) item['container-title'] = container
  const authors = names(message.author)
  if (authors) item.author = authors
  const editors = names(message.editor)
  if (editors) item.editor = editors
  if (Array.isArray(issuedParts) && Array.isArray(issuedParts[0])) {
    item.issued = { 'date-parts': [issuedParts[0].map(Number)] }
  }
  if (typeof message.volume === 'string') item.volume = message.volume
  if (typeof message.issue === 'string') item.issue = message.issue
  if (typeof message.page === 'string') item.page = message.page
  if (typeof message.publisher === 'string') item.publisher = message.publisher
  const isbn = firstString(message.ISBN)
  if (isbn) item.ISBN = isbn
  if (typeof message.URL === 'string') item.URL = message.URL
  return item
}

function crossrefType(type: string | undefined): string {
  switch (type) {
    case 'journal-article':
      return 'article-journal'
    case 'book':
    case 'monograph':
      return 'book'
    case 'book-chapter':
      return 'chapter'
    case 'proceedings-article':
      return 'paper-conference'
    case 'dissertation':
      return 'thesis'
    case 'report':
      return 'report'
    case 'posted-content':
      return 'manuscript'
    default:
      return 'document'
  }
}

/**
 * Open Library's book record into a CSL item.
 *
 * Its dates are free text ("June 1, 2015", "2015"), so only a four-digit year
 * is taken — inventing a month from an ambiguous string would be worse than
 * having none.
 */
export function openLibraryToCsl(record: Record<string, unknown>, isbn: string): CslItem | null {
  const title = typeof record.title === 'string' ? record.title : null
  if (!title) return null

  const item: CslItem = { id: `isbn-${isbn}`, type: 'book', title, ISBN: isbn }

  const subtitle = typeof record.subtitle === 'string' ? record.subtitle : null
  if (subtitle) item.title = `${title}: ${subtitle}`

  const authors = Array.isArray(record.authors)
    ? (record.authors as Array<{ name?: string }>)
        .map((author) => author.name)
        .filter((name): name is string => typeof name === 'string')
    : []
  if (authors.length > 0) {
    item.author = authors.map((name) => {
      const words = name.trim().split(/\s+/)
      return words.length > 1
        ? { family: words[words.length - 1]!, given: words.slice(0, -1).join(' ') }
        : { literal: name.trim() }
    })
  }

  const publishers = Array.isArray(record.publishers)
    ? (record.publishers as Array<{ name?: string } | string>).map((entry) =>
        typeof entry === 'string' ? entry : entry.name
      )
    : []
  const publisher = publishers.find((name): name is string => typeof name === 'string')
  if (publisher) item.publisher = publisher

  const place = Array.isArray(record.publish_places)
    ? (record.publish_places as Array<{ name?: string }>).find((entry) => entry.name)?.name
    : undefined
  if (place) item['publisher-place'] = place

  const year = /(\d{4})/.exec(typeof record.publish_date === 'string' ? record.publish_date : '')
  if (year) item.issued = { 'date-parts': [[Number(year[1])]] }

  if (typeof record.url === 'string') item.URL = record.url
  return item
}

async function getJson(url: string): Promise<unknown | 'offline' | 'not-found'> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (response.status === 404) return 'not-found'
    if (!response.ok) return 'offline'
    return (await response.json()) as unknown
  } catch {
    // A DNS failure, a refused connection and a timeout are one thing to the
    // person looking at the panel: the service could not be reached.
    return 'offline'
  }
}

/** Look a source up by DOI or ISBN, deciding which from the text itself. */
export async function lookupSource(raw: string): Promise<LookupResult> {
  const doi = normalizeDoi(raw)
  if (doi) {
    const payload = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)
    if (payload === 'offline') return { ok: false, reason: 'offline' }
    if (payload === 'not-found') return { ok: false, reason: 'not-found' }
    const message = (payload as { message?: Record<string, unknown> })?.message
    if (!message) return { ok: false, reason: 'malformed' }
    const item = crossrefToCsl(message)
    return item ? { ok: true, item } : { ok: false, reason: 'malformed' }
  }

  const isbn = normalizeIsbn(raw)
  if (isbn) {
    const payload = await getJson(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&jscmd=data&format=json`
    )
    if (payload === 'offline') return { ok: false, reason: 'offline' }
    if (payload === 'not-found') return { ok: false, reason: 'not-found' }
    const record = (payload as Record<string, Record<string, unknown>>)?.[`ISBN:${isbn}`]
    // Open Library answers `{}` with a 200 for an ISBN it has never heard of.
    if (!record) return { ok: false, reason: 'not-found' }
    const item = openLibraryToCsl(record, isbn)
    return item ? { ok: true, item } : { ok: false, reason: 'malformed' }
  }

  return { ok: false, reason: 'unsupported' }
}
