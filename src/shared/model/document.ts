import { z } from 'zod'
import { FORMAT_VERSION } from '../constants.js'

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
 * The on-disk envelope for a `.pubdoc`.
 *
 * `docId` lives inside the file rather than being derived from its path, so
 * backlinks, snapshots, storyboard references and restored dock panels all
 * survive a rename or move.
 */
export const pubDocumentSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  docId: z.string(),
  title: z.string(),
  created: z.string(),
  modified: z.string(),
  wordCount: z.number().int().default(0),
  content: pmDocSchema
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
