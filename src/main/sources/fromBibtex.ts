import type { CslItem } from '../../shared/model/source.js'

/**
 * BibTeX → CSL-JSON.
 *
 * Written against what reference managers actually emit rather than against
 * the TeX grammar, for the reason `docx/fromDocx.ts` gives about OOXML: the
 * files this has to read come from Zotero, Mendeley, JabRef and Google
 * Scholar, and each has its own habits — brace-protected titles, `and`-joined
 * author lists, month macros, `--` page ranges. A strict grammar would reject
 * files every one of those tools considers valid.
 *
 * Deliberately tolerant: an entry that cannot be understood is skipped and
 * reported, never thrown, so one malformed record in a library of four hundred
 * does not lose the other three hundred and ninety-nine.
 */
export interface ImportResult {
  items: CslItem[]
  warnings: string[]
}

/** BibTeX entry types → CSL types. Anything unlisted falls back to `document`. */
const TYPE_MAP: Record<string, string> = {
  article: 'article-journal',
  book: 'book',
  booklet: 'book',
  inbook: 'chapter',
  incollection: 'chapter',
  inproceedings: 'paper-conference',
  conference: 'paper-conference',
  manual: 'report',
  mastersthesis: 'thesis',
  phdthesis: 'thesis',
  misc: 'document',
  proceedings: 'book',
  techreport: 'report',
  unpublished: 'manuscript',
  online: 'webpage',
  electronic: 'webpage'
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
}

/**
 * Strip the braces BibTeX uses for capitalisation protection, and translate
 * the handful of TeX escapes that show up in real bibliographies.
 *
 * `{\"o}` and `\"{o}` are both common — Zotero writes the first, BibDesk the
 * second — so both spellings are handled rather than only whichever one the
 * first test file happened to contain.
 */
export function cleanValue(raw: string): string {
  let text = raw.trim()

  const accents: Array<[RegExp, string]> = [
    [/\{?\\`\{?([aeiouAEIOU])\}?\}?/g, '$1̀'],
    [/\{?\\'\{?([aeiouyAEIOUY])\}?\}?/g, '$1́'],
    [/\{?\\\^\{?([aeiouAEIOU])\}?\}?/g, '$1̂'],
    [/\{?\\~\{?([anoANO])\}?\}?/g, '$1̃'],
    [/\{?\\"\{?([aeiouAEIOU])\}?\}?/g, '$1̈'],
    [/\{?\\c\{?([cC])\}?\}?/g, '$1̧']
  ]
  for (const [pattern, replacement] of accents) text = text.replace(pattern, replacement)
  text = text.normalize('NFC')

  text = text
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/\\_/g, '_')
    .replace(/\\\$/g, '$')
    .replace(/\\#/g, '#')
    .replace(/~/g, ' ')
    .replace(/\\emph\{([^}]*)\}/g, '$1')
    .replace(/\\textit\{([^}]*)\}/g, '$1')
    .replace(/\\textbf\{([^}]*)\}/g, '$1')

  // Only the protective braces come out; the text inside them stays.
  text = text.replace(/[{}]/g, '')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Split a BibTeX author field on its `and` separators.
 *
 * Only a bare `and` at brace depth zero separates names — "Smith and Sons,
 * Ltd." inside braces is one corporate author, not two people.
 */
function splitNames(raw: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  const tokens = raw.split(/(\s+)/)
  for (const token of tokens) {
    for (const character of token) {
      if (character === '{') depth++
      if (character === '}') depth--
    }
    if (depth === 0 && token.trim().toLowerCase() === 'and') {
      parts.push(current)
      current = ''
      continue
    }
    current += token
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/**
 * One BibTeX name into a CSL name.
 *
 * "Family, Given" and "Given Family" are both in the wild. A name wrapped
 * whole in braces is a corporate author and becomes a `literal`, since
 * splitting "{World Health Organization}" into given/family would render it
 * as an initial and a surname.
 */
export function parseName(raw: string): { family?: string; given?: string; literal?: string } {
  const trimmed = raw.trim()
  if (/^\{.*\}$/.test(trimmed)) return { literal: cleanValue(trimmed) }

  if (trimmed.includes(',')) {
    const [family, given] = trimmed.split(',', 2)
    return { family: cleanValue(family ?? ''), given: cleanValue(given ?? '') }
  }

  const words = trimmed.split(/\s+/)
  if (words.length === 1) return { literal: cleanValue(trimmed) }
  return {
    family: cleanValue(words[words.length - 1]!),
    given: cleanValue(words.slice(0, -1).join(' '))
  }
}

/** Field values: `{braced}`, "quoted", or a bare number/macro. */
function readFields(body: string): Map<string, string> {
  const fields = new Map<string, string>()
  let index = 0

  const skipSpace = (): void => {
    while (index < body.length && /\s/.test(body[index]!)) index++
  }

  while (index < body.length) {
    skipSpace()
    if (index >= body.length || body[index] === ',') {
      index++
      continue
    }

    let key = ''
    while (index < body.length && /[A-Za-z0-9_+:-]/.test(body[index]!)) key += body[index++]!
    if (!key) {
      index++
      continue
    }

    skipSpace()
    if (body[index] !== '=') continue
    index++
    skipSpace()

    let value = ''
    if (body[index] === '{') {
      let depth = 0
      do {
        const character = body[index]!
        if (character === '{') depth++
        if (character === '}') depth--
        value += character
        index++
      } while (index < body.length && depth > 0)
      value = value.slice(1, -1)
    } else if (body[index] === '"') {
      index++
      let depth = 0
      while (index < body.length && !(body[index] === '"' && depth === 0)) {
        if (body[index] === '{') depth++
        if (body[index] === '}') depth--
        value += body[index++]!
      }
      index++
    } else {
      while (index < body.length && body[index] !== ',' && body[index] !== '\n') value += body[index++]!
    }

    fields.set(key.toLowerCase().trim(), value)
  }

  return fields
}

function issuedFrom(fields: Map<string, string>): CslItem['issued'] | undefined {
  const year = cleanValue(fields.get('year') ?? '')
  const date = cleanValue(fields.get('date') ?? '')
  // Biblatex's `date` is ISO and more precise than `year` when both are present.
  const isoMatch = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(date)
  if (isoMatch) {
    const parts = [Number(isoMatch[1])]
    if (isoMatch[2]) parts.push(Number(isoMatch[2]))
    if (isoMatch[3]) parts.push(Number(isoMatch[3]))
    return { 'date-parts': [parts] }
  }

  const yearMatch = /(\d{4})/.exec(year)
  if (!yearMatch) return undefined
  const parts = [Number(yearMatch[1])]

  const rawMonth = cleanValue(fields.get('month') ?? '').toLowerCase().slice(0, 3)
  const month = MONTHS[rawMonth] ?? (/^\d{1,2}$/.test(rawMonth) ? Number(rawMonth) : undefined)
  if (month) parts.push(month)
  return { 'date-parts': [parts] }
}

const SIMPLE_FIELDS: Array<[string, string]> = [
  ['title', 'title'],
  ['publisher', 'publisher'],
  ['volume', 'volume'],
  ['number', 'issue'],
  ['doi', 'DOI'],
  ['isbn', 'ISBN'],
  ['url', 'URL'],
  ['abstract', 'abstract'],
  ['edition', 'edition'],
  ['note', 'note'],
  ['series', 'collection-title'],
  ['address', 'publisher-place'],
  ['location', 'publisher-place']
]

/** Where each entry type looks for its container title, most specific first. */
const CONTAINER_FIELDS = ['journal', 'journaltitle', 'booktitle']

export function parseBibtex(text: string): ImportResult {
  const items: CslItem[] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  // `@string`/`@comment`/`@preamble` are not references and are skipped rather
  // than reported — a file containing them is perfectly ordinary.
  const entry = /@(\w+)\s*\{\s*([^,\s}]*)\s*,/g
  let match: RegExpExecArray | null

  while ((match = entry.exec(text)) !== null) {
    const kind = match[1]!.toLowerCase()
    if (kind === 'string' || kind === 'comment' || kind === 'preamble') continue

    const key = match[2]!.trim()
    // Walk to the matching close brace so a nested `{...}` inside a field
    // cannot end the entry early.
    let depth = 1
    let index = entry.lastIndex
    while (index < text.length && depth > 0) {
      if (text[index] === '{') depth++
      if (text[index] === '}') depth--
      index++
    }
    if (depth !== 0) {
      warnings.push(`Entry “${key || kind}” is missing its closing brace and was skipped.`)
      break
    }

    const body = text.slice(entry.lastIndex, index - 1)
    entry.lastIndex = index

    const fields = readFields(body)
    const title = cleanValue(fields.get('title') ?? '')
    if (!key && !title) {
      warnings.push(`An @${kind} entry has neither a key nor a title and was skipped.`)
      continue
    }

    let id = key || title.slice(0, 40)
    if (seen.has(id)) {
      // Two entries under one key would collapse into one source, and a
      // citation could then never name the second.
      let suffix = 2
      while (seen.has(`${id}-${suffix}`)) suffix++
      warnings.push(`Two entries share the key “${id}”; the second was imported as “${id}-${suffix}”.`)
      id = `${id}-${suffix}`
    }
    seen.add(id)

    const item: CslItem = { id, type: TYPE_MAP[kind] ?? 'document' }

    for (const [from, to] of SIMPLE_FIELDS) {
      const value = fields.get(from)
      if (value === undefined) continue
      const cleaned = cleanValue(value)
      if (cleaned && item[to] === undefined) item[to] = cleaned
    }

    for (const field of CONTAINER_FIELDS) {
      const value = fields.get(field)
      if (value) {
        item['container-title'] = cleanValue(value)
        break
      }
    }

    const pages = cleanValue(fields.get('pages') ?? '')
    if (pages) item.page = pages.replace(/\s*-{2,}\s*/g, '-')

    for (const [field, key2] of [
      ['author', 'author'],
      ['editor', 'editor']
    ] as const) {
      const value = fields.get(field)
      if (!value) continue
      const names = splitNames(value).map(parseName)
      if (names.length > 0) item[key2] = names
    }

    const issued = issuedFrom(fields)
    if (issued) item.issued = issued

    items.push(item)
  }

  return { items, warnings }
}
