import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'

/**
 * A PDF or web-capture attachment for a source in `sources.json`.
 *
 * The attachment's bytes/text never live in the CSL item itself — only this
 * index entry does, riding in `CslItem.catchall['_pubAttachments']` (see
 * `source.ts`'s `.catchall` note). Namespacing under `_pubAttachments` is
 * what keeps a BibTeX round-trip and citeproc both indifferent to it: they
 * see an unrecognised catchall key and pass it through untouched.
 */
export const researchAttachmentSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  kind: z.enum(['pdf', 'capture']),
  title: z.string().default(''),
  /** Original filename or URL, for display only — never used to resolve a path. */
  label: z.string().default(''),
  added: z.string()
})
export type ResearchAttachment = z.infer<typeof researchAttachmentSchema>

/** The namespaced catchall key an attachment index rides under on a `CslItem`. */
export const PUB_ATTACHMENTS_KEY = '_pubAttachments'

export const pubAttachmentsSchema = z.array(researchAttachmentSchema)
export type PubAttachments = z.infer<typeof pubAttachmentsSchema>

/**
 * A web capture's stored content: `.thepub/research/<sourceId>/<attachmentId>.capture.json`.
 * Readable text and title only — see `docs/phase-11-plan.md`'s "no full-page archive".
 */
export const captureSchema = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  accessed: z.string()
})
export type Capture = z.infer<typeof captureSchema>

/**
 * A highlight made inside a research attachment — a PDF or a web capture.
 * Mirrors `Highlight` (`highlight.ts`) for the same reasons, anchored by
 * quoted text first: page/rects second for PDFs (`pdfAnchor.ts`), a text
 * offset second for captures (`captureAnchor.ts`) — a capture has no page or
 * coordinate system, only its stored plain text, so `offset` is the whole of
 * its recovery hint.
 */
export const pdfHighlightSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  attachmentId: z.string(),
  kind: z.enum(['pdf', 'capture']).default('pdf'),
  color: z.string(),
  categoryId: z.string().default(''),
  note: z.string().default(''),
  authorId: z.string().default(''),
  quote: z.string(),
  /** PDF only. Unused (0) for a capture highlight. */
  page: z.number().int().default(0),
  /** `[x0, y0, x1, y1]` in unrotated PDF page-space, one per selected rect. Recovery hint only. */
  rects: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).default(() => []),
  /** Capture only: character offset of `quote` in the capture's stored text. `-1` when unknown. */
  offset: z.number().int().default(-1),
  orphaned: z.boolean().default(false),
  created: z.string(),
  modified: z.string()
})
export type PdfHighlight = z.infer<typeof pdfHighlightSchema>
/** Same shape, read where the code means "a highlight in any research attachment" rather than "a PDF one". */
export type AttachmentHighlight = PdfHighlight

export const pdfHighlightFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.pdfHighlights),
  highlights: z.array(pdfHighlightSchema).default(() => [])
})
export type PdfHighlightFile = z.infer<typeof pdfHighlightFileSchema>

export const EMPTY_PDF_HIGHLIGHT_FILE: PdfHighlightFile = {
  formatVersion: FORMAT_VERSIONS.pdfHighlights,
  highlights: []
}
