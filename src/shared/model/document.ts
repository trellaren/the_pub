import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'

/**
 * A section's page geometry. Envelope-level, like `sections` itself — see
 * that field's own comment for why headers, footers and page setup are never
 * ProseMirror content.
 */
export const pageMarginsSchema = z.object({
  top: z.number(),
  bottom: z.number(),
  left: z.number(),
  right: z.number()
})
export type PageMargins = z.infer<typeof pageMarginsSchema>

export const pageSetupSchema = z.object({
  width: z.number(),
  height: z.number(),
  /** Uniform margin, used when `margins` is absent. */
  margin: z.number().default(72),
  /**
   * Per-side margins. Optional so every section written before these existed
   * — and any writer who only ever wants one number — keeps meaning what it
   * meant; read through `pageMargins()`, never directly.
   */
  margins: pageMarginsSchema.optional(),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  /** Stored for a future pagination pass to read; export does not lay out columns yet. */
  columns: z.number().int().min(1).default(1)
})
export type PageSetup = z.infer<typeof pageSetupSchema>

/** The project settings' page margins as a `PageSetup`-shaped block. Structural, to stay import-free of the manifest. */
export function marginsFromSettings(settings: {
  pageMarginTop: number
  pageMarginBottom: number
  pageMarginLeft: number
  pageMarginRight: number
}): PageMargins {
  return {
    top: settings.pageMarginTop,
    bottom: settings.pageMarginBottom,
    left: settings.pageMarginLeft,
    right: settings.pageMarginRight
  }
}

/** The four margins a page actually has, whichever way this setup states them. */
export function pageMargins(setup: Pick<PageSetup, 'margin' | 'margins'>): PageMargins {
  return (
    setup.margins ?? {
      top: setup.margin,
      bottom: setup.margin,
      left: setup.margin,
      right: setup.margin
    }
  )
}

/**
 * ProseMirror document JSON. Kept structurally loose on purpose: the editor's
 * schema is the authority on node shapes, and the persistence layer must not
 * reject documents produced by a newer extension set.
 */
export const pmNodeSchema: z.ZodType<PmNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(pmNodeSchema).optional(),
    marks: z.array(z.object({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() })).optional(),
    text: z.string().optional()
  })
)
export interface PmMark {
  type: string
  attrs?: Record<string, unknown>
}
export interface PmNode {
  type: string
  attrs?: Record<string, unknown>
  content?: PmNode[]
  marks?: PmMark[]
  text?: string
}

export const pmDocSchema = z.object({
  type: z.literal('doc'),
  attrs: z.record(z.string(), z.unknown()).optional(),
  content: z.array(pmNodeSchema).optional()
})
export type PmDoc = z.infer<typeof pmDocSchema>

/**
 * A run of the document with its own page setup, header and footer.
 *
 * Not ProseMirror content, deliberately. If it were, it would sit inside the
 * document's own position space, and then `extractPlainText` would feed
 * header text to search and to the AI context, `countWords` would count it,
 * `diffBlocks` would show a header edit as a body change in the History
 * panel, the mention scanner would match a name in a running header, and
 * find/replace would walk into it. Every one of those is a real bug, and
 * each would need a special case in a different file. Keeping sections a
 * sibling of `content` costs one schema field and makes all five not exist —
 * and it is what makes the `.docx` mapping mechanical, since OOXML's
 * `sectPr` is itself envelope-level.
 *
 * `startBlockIndex` is unused until a second section can exist (nothing
 * today creates more than one); it is here now so that shape does not become
 * a later format migration.
 */
export const sectionSchema = z.object({
  startBlockIndex: z.number().int().min(0),
  page: pageSetupSchema,
  header: pmDocSchema.optional(),
  footer: pmDocSchema.optional(),
  headerFirstPage: pmDocSchema.optional(),
  footerFirstPage: pmDocSchema.optional()
})
export type Section = z.infer<typeof sectionSchema>

/**
 * The on-disk envelope for a `.pubdoc`.
 *
 * `docId` lives inside the file rather than being derived from its path, so
 * backlinks, snapshots, storyboard references and restored dock panels all
 * survive a rename or move.
 */
export const pubDocumentSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.document),
  docId: z.string(),
  title: z.string(),
  created: z.string(),
  modified: z.string(),
  wordCount: z.number().int().default(0),
  content: pmDocSchema,
  /** Absent means the project's default page setup (`manifest.settings`) and no headers or footers. */
  sections: z.array(sectionSchema).optional(),
  /**
   * BCP-47 language tag for the whole document, e.g. `en-US` or `he`. Lives on
   * the envelope, not in the ProseMirror content, for the same reason
   * `sections` does: it must not be seen as body text by find/replace, word
   * count, the diff or the mention scanner. Drives the editor's `lang`
   * attribute, the spellchecker, and DOCX `w:lang` on export. Absent means the
   * project's default (`manifest.publication.language`), then the OS default.
   */
  lang: z.string().optional()
})
export type PubDocument = z.infer<typeof pubDocumentSchema>

export const EMPTY_DOC: PmDoc = { type: 'doc', content: [{ type: 'paragraph' }] }

/** A document as loaded into the renderer, with the disk state needed to detect conflicts. */
export const loadedDocumentSchema = z.object({
  doc: pubDocumentSchema,
  path: z.string(),
  mtime: z.number()
})
export type LoadedDocument = z.infer<typeof loadedDocumentSchema>
