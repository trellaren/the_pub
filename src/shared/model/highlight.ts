import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'

/**
 * A collected highlight: metadata for one `highlightId` stamped on the
 * `highlight` mark. Not every highlighted range has one of these — an
 * uncollected highlight is just yellow text, with nothing here to describe
 * it. See `docs/phase-11-plan.md`.
 */
export const highlightSchema = z.object({
  id: z.string(),
  docId: z.string(),
  highlightId: z.string(),
  /** The mark's own colour, mirrored here so the panel can render without opening the document. */
  color: z.string(),
  /** A project-defined `HighlightCategoryDef.id`, or empty for uncategorised. */
  categoryId: z.string().default(''),
  note: z.string().default(''),
  authorId: z.string().default(''),
  /** The highlighted text, for recovery and for the panel — the same role `Note.anchorText` plays. */
  quote: z.string(),
  blockIndex: z.number().int(),
  /** Whether `highlightId` could be found in the document as of the last reconcile. Never deleted, only flagged. */
  orphaned: z.boolean().default(false),
  created: z.string(),
  modified: z.string()
})
export type Highlight = z.infer<typeof highlightSchema>

/** One document's worth of collected highlights: `.thepub/highlights/<docId>.json`. */
export const highlightFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.highlights),
  highlights: z.array(highlightSchema).default(() => [])
})
export type HighlightFile = z.infer<typeof highlightFileSchema>

export const EMPTY_HIGHLIGHT_FILE: HighlightFile = {
  formatVersion: FORMAT_VERSIONS.highlights,
  highlights: []
}
