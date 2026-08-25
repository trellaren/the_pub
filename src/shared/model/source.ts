import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'

/**
 * A bibliographic source, stored as CSL-JSON rather than a schema of our own
 * invention — a hand-rolled shape would only have to be translated into
 * CSL-JSON later, for whichever citation engine ends up rendering it, and
 * BibTeX/RIS import would face the same translation a second time. Storing
 * what the engine eats means both are one less step.
 *
 * `.catchall` on every object here, deliberately, mirrors `pmNodeSchema`'s
 * permissiveness (`model/document.ts`): CSL-JSON has on the order of sixty
 * possible fields across all reference types, it keeps growing, and this
 * schema's job is to confirm the envelope — id, type, enough to sort and
 * display a picker entry — not to police which of those sixty a given source
 * may use. Rejecting a field this build doesn't know about would lose data on
 * a BibTeX or Zotero import round-trip.
 */
const cslNameSchema = z
  .object({
    family: z.string().optional(),
    given: z.string().optional(),
    literal: z.string().optional()
  })
  .catchall(z.unknown())
export type CslName = z.infer<typeof cslNameSchema>

/** CSL's `date-parts`: `[[2019]]`, `[[2019, 3]]`, or a range `[[2019], [2020, 6]]`. */
const cslDateSchema = z
  .object({
    'date-parts': z.array(z.array(z.number())).optional(),
    literal: z.string().optional(),
    circa: z.boolean().optional()
  })
  .catchall(z.unknown())
export type CslDate = z.infer<typeof cslDateSchema>

/**
 * `type` is deliberately `z.string()` rather than an enum of CSL's ~40
 * reference types. The picker and the (eventual) rendering engine both need
 * to recognise a handful of common ones, but a project citing a `legal_case`
 * or a `patent` must not be blocked by this schema not having heard of it.
 */
export const cslItemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    title: z.string().optional(),
    author: z.array(cslNameSchema).optional(),
    editor: z.array(cslNameSchema).optional(),
    issued: cslDateSchema.optional(),
    'container-title': z.string().optional(),
    publisher: z.string().optional(),
    'publisher-place': z.string().optional(),
    volume: z.string().optional(),
    issue: z.string().optional(),
    page: z.string().optional(),
    DOI: z.string().optional(),
    ISBN: z.string().optional(),
    URL: z.string().optional()
  })
  .catchall(z.unknown())
export type CslItem = z.infer<typeof cslItemSchema>

/**
 * The namespaced catchall key marking a source the assistant attributed and
 * nobody has accepted, alongside `_pubAttachments`.
 *
 * Namespaced rather than a bare `provisional` for the reason attachments are:
 * this is our bookkeeping riding on a CSL-JSON item, and a citation processor
 * handed the library must ignore it rather than try to render it.
 */
export const PUB_PROVISIONAL_KEY = '_pubProvisional'

/** Whether a source is the assistant's attribution, not yet checked by a person. */
export function isProvisional(item: CslItem): boolean {
  return (item as Record<string, unknown>)[PUB_PROVISIONAL_KEY] === true
}

export function withProvisional(item: CslItem, provisional: boolean): CslItem {
  if (!provisional) {
    const { [PUB_PROVISIONAL_KEY]: _dropped, ...rest } = item as Record<string, unknown>
    return rest as CslItem
  }
  return { ...item, [PUB_PROVISIONAL_KEY]: true }
}

/**
 * Whether a source names a work someone could go and check.
 *
 * The bar the assistant's `add_source` has to clear. An entry with neither a
 * URL nor an identifiable work is not a citation, it is a sentence — and an
 * uncheckable citation in a thesis bibliography is career damage, so it is
 * refused rather than stored with a caveat.
 */
export function isCheckable(item: CslItem): boolean {
  const hasWork = Boolean(item.title?.trim() && (authorNames(item) || item['container-title'] || item.publisher))
  return Boolean(item.URL?.trim() || item.DOI?.trim() || item.ISBN?.trim() || hasWork)
}

export const sourceFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.sources),
  sources: z.array(cslItemSchema).default(() => [])
})
export type SourceFile = z.infer<typeof sourceFileSchema>

export const EMPTY_SOURCE_FILE: SourceFile = {
  formatVersion: FORMAT_VERSIONS.sources,
  sources: []
}

/**
 * The reference types the source editor offers by name — the handful a
 * project actually cites most often, out of CSL's ~40. `type` itself stays
 * `z.string()` (see `cslItemSchema`), so choosing one here is a convenience,
 * not a constraint: an imported source with a rarer type is still shown and
 * still cites correctly, just without a friendly label in this list.
 */
export const CSL_TYPES = [
  { id: 'book', name: 'Book' },
  { id: 'chapter', name: 'Book chapter' },
  { id: 'article-journal', name: 'Journal article' },
  { id: 'article-magazine', name: 'Magazine article' },
  { id: 'article-newspaper', name: 'Newspaper article' },
  { id: 'webpage', name: 'Web page' },
  { id: 'thesis', name: 'Thesis' },
  { id: 'report', name: 'Report' },
  { id: 'interview', name: 'Interview' },
  { id: 'speech', name: 'Speech' }
] as const

/**
 * The styles the picker offers by name. `citeproc-plus` bundles roughly 2000
 * — every style the CSL project maintains — so this is a curated shortlist,
 * not the ceiling: `citationStyleId` (`model/manifest.ts`) is a plain string,
 * and a project can be pointed at any style id this list doesn't mention.
 */
export const CITATION_STYLES = [
  { id: 'chicago-author-date', name: 'Chicago (author-date)' },
  { id: 'chicago-notes-bibliography', name: 'Chicago (notes-bibliography)' },
  { id: 'apa', name: 'APA' },
  { id: 'modern-language-association', name: 'MLA' }
] as const

/** One line of author surnames, for a picker row or a provisional citation. */
export function authorNames(item: CslItem): string {
  const names = (item.author ?? [])
    .map((name) => name.family ?? name.literal ?? name.given)
    .filter((name): name is string => Boolean(name))
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]} et al.`
}

/** The year alone, out of CSL's `date-parts` — what a short in-text citation needs. */
export function issuedYear(item: CslItem): string | null {
  const parts = item.issued?.['date-parts']?.[0]
  if (parts && parts.length > 0) return String(parts[0])
  return item.issued?.literal ?? null
}

/** A row's worth of text for the citation picker: author, year, title. */
export function describeSource(item: CslItem): string {
  const author = authorNames(item)
  const year = issuedYear(item)
  const bits = [author, year ? `(${year})` : null, item.title ?? '(untitled)'].filter(Boolean)
  return bits.join(' ')
}
