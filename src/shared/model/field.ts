import { z } from 'zod'

/**
 * A computed span of text embedded in a document: a table-of-contents entry
 * or a cross-reference to a heading elsewhere.
 *
 * `field`, not `toc`/`ref`/two node types, so every future computed-text kind
 * (a citation, eventually) is a consumer of the same node rather than one more
 * type every part of the app that walks the document has to learn about.
 *
 * `cachedText` is a real text child of the node, not just an attribute — see
 * `extensions/field.ts` for why: it is what lets `extractPlainText`,
 * `countWords`, search and DOCX export treat a field exactly like the prose
 * around it, with no field-shaped special case anywhere in any of them.
 */
export const fieldKindSchema = z.enum(['ref', 'toc'])
export type FieldKind = z.infer<typeof fieldKindSchema>

export const fieldAttrsSchema = z.object({
  kind: fieldKindSchema,
  /** The heading's `blockId` (Phase 0), or `null` if its target has never resolved. */
  targetBlockId: z.string().nullable(),
  /** The outline level of the target heading, 1-6. Drives a `toc` entry's indent. */
  level: z.number().int().min(1).max(6).optional()
})
export type FieldAttrs = z.infer<typeof fieldAttrsSchema>

export const FIELD_NODE = 'field'
