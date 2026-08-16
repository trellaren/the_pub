import type { CslItem } from '../../shared/model/source.js'
import type { ImportResult } from './fromBibtex.js'

/**
 * RIS → CSL-JSON.
 *
 * RIS is line-oriented and far simpler than BibTeX, but no less varied in
 * practice: EndNote writes `T1`/`A1`, Scopus writes `TI`/`AU`, and both are
 * ordinary files someone will try to import. Tags are therefore read as
 * synonyms rather than one canonical set.
 *
 * Tolerant in the same way as the BibTeX reader: a record that makes no sense
 * is skipped with a warning rather than throwing, so one bad record cannot
 * cost someone the rest of their library.
 */

/** RIS reference types → CSL types. Unlisted falls back to `document`. */
const TYPE_MAP: Record<string, string> = {
  JOUR: 'article-journal',
  BOOK: 'book',
  CHAP: 'chapter',
  CONF: 'paper-conference',
  CPAPER: 'paper-conference',
  THES: 'thesis',
  RPRT: 'report',
  MGZN: 'article-magazine',
  NEWS: 'article-newspaper',
  ELEC: 'webpage',
  WEB: 'webpage',
  GEN: 'document',
  UNPB: 'manuscript'
}

/** Tag synonyms, so EndNote and Scopus files both read correctly. */
const TITLE_TAGS = ['TI', 'T1']
const CONTAINER_TAGS = ['JO', 'JF', 'T2', 'JA', 'BT']
const AUTHOR_TAGS = ['AU', 'A1']
const EDITOR_TAGS = ['ED', 'A2']
const DATE_TAGS = ['PY', 'Y1', 'DA']

const SIMPLE_TAGS: Array<[string, string]> = [
  ['VL', 'volume'],
  ['IS', 'issue'],
  ['PB', 'publisher'],
  ['CY', 'publisher-place'],
  ['DO', 'DOI'],
  ['SN', 'ISBN'],
  ['UR', 'URL'],
  ['AB', 'abstract'],
  ['ET', 'edition']
]

/**
 * A name as RIS writes it: "Family, Given" almost always, but a single-token
 * value is an organisation rather than a bare surname.
 */
function parseName(raw: string): { family?: string; given?: string; literal?: string } {
  const trimmed = raw.trim().replace(/,\s*$/, '')
  if (trimmed.includes(',')) {
    const [family, given] = trimmed.split(',', 2)
    return { family: family!.trim(), given: (given ?? '').trim() }
  }
  if (!trimmed.includes(' ')) return { literal: trimmed }
  return { literal: trimmed }
}

function issuedFrom(values: string[]): CslItem['issued'] | undefined {
  for (const value of values) {
    // "2015/06/01/" is EndNote's shape; "2019" is Scopus's.
    const match = /(\d{4})(?:[/-](\d{1,2}))?(?:[/-](\d{1,2}))?/.exec(value)
    if (!match) continue
    const parts = [Number(match[1])]
    if (match[2]) parts.push(Number(match[2]))
    if (match[3]) parts.push(Number(match[3]))
    return { 'date-parts': [parts] }
  }
  return undefined
}

/** An id for a record RIS gave no key, stable enough to cite and read. */
function deriveId(item: CslItem, index: number): string {
  const family = item.author?.[0]?.family ?? item.author?.[0]?.literal ?? ''
  const year = item.issued?.['date-parts']?.[0]?.[0] ?? ''
  const stem = `${family}${year}`.replace(/[^A-Za-z0-9]/g, '')
  return stem || `ris-${index + 1}`
}

export function parseRis(text: string): ImportResult {
  const items: CslItem[] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  // Records are separated by `ER  -`. Splitting on it rather than on blank
  // lines is what lets a wrapped abstract contain blank lines safely.
  const lines = text.split(/\r?\n/)
  let current: Map<string, string[]> | null = null
  let lastTag: string | null = null

  const finish = (): void => {
    if (!current) return
    const fields = current
    current = null
    lastTag = null

    const type = TYPE_MAP[(fields.get('TY')?.[0] ?? '').toUpperCase()] ?? 'document'
    const item: CslItem = { id: '', type }

    const first = (tags: string[]): string | undefined => {
      for (const tag of tags) {
        const value = fields.get(tag)?.[0]
        if (value) return value
      }
      return undefined
    }

    const title = first(TITLE_TAGS)
    if (title) item.title = title
    const container = first(CONTAINER_TAGS)
    if (container) item['container-title'] = container

    for (const [tag, key] of SIMPLE_TAGS) {
      const value = fields.get(tag)?.[0]
      if (value) item[key] = value
    }

    const authors = AUTHOR_TAGS.flatMap((tag) => fields.get(tag) ?? [])
    if (authors.length > 0) item.author = authors.map(parseName)
    const editors = EDITOR_TAGS.flatMap((tag) => fields.get(tag) ?? [])
    if (editors.length > 0) item.editor = editors.map(parseName)

    const issued = issuedFrom(DATE_TAGS.flatMap((tag) => fields.get(tag) ?? []))
    if (issued) item.issued = issued

    const start = fields.get('SP')?.[0]
    const end = fields.get('EP')?.[0]
    if (start) item.page = end ? `${start}-${end}` : start

    if (!item.title && !item.author) {
      warnings.push('A record with neither a title nor an author was skipped.')
      return
    }

    let id = deriveId(item, items.length)
    if (seen.has(id)) {
      let suffix = 2
      while (seen.has(`${id}-${suffix}`)) suffix++
      id = `${id}-${suffix}`
    }
    seen.add(id)
    item.id = id
    items.push(item)
  }

  for (const line of lines) {
    const tagged = /^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/.exec(line)
    if (tagged) {
      const tag = tagged[1]!
      const value = tagged[2]!.trim()
      if (tag === 'ER') {
        finish()
        continue
      }
      if (tag === 'TY') current = new Map()
      if (!current) current = new Map()
      const existing = current.get(tag) ?? []
      current.set(tag, [...existing, value])
      lastTag = tag
      continue
    }

    // A continuation line: RIS wraps long abstracts with no tag of their own.
    const continuation = line.trim()
    if (!continuation || !current || !lastTag) continue
    const existing = current.get(lastTag)
    if (!existing || existing.length === 0) continue
    existing[existing.length - 1] = `${existing[existing.length - 1]} ${continuation}`.trim()
  }

  // A file whose last record has no `ER  -` is common enough to accept.
  finish()

  return { items, warnings }
}
