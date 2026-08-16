import { z } from 'zod'

/**
 * A computed span of text embedded in a document: a table-of-contents entry
 * or a cross-reference to a heading elsewhere.
 *
 * `field`, not `toc`/`ref`/two node types, so every future computed-text kind
 * — `citation` and `bibliography`, added in Phase 5 — is a consumer of the
 * same node rather than one more type every part of the app that walks the
 * document has to learn about.
 *
 * `cachedText` is a real text child of the node, not just an attribute — see
 * `extensions/field.ts` for why: it is what lets `extractPlainText`,
 * `countWords`, search and DOCX export treat a field exactly like the prose
 * around it, with no field-shaped special case anywhere in any of them. That
 * is exactly as true of a rendered citation as it is of a cross-reference or
 * a contents entry, which is the whole reason citations are a `field` kind
 * rather than a fifth node type.
 */
export const fieldKindSchema = z.enum(['ref', 'toc', 'citation', 'bibliography'])
export type FieldKind = z.infer<typeof fieldKindSchema>

export const fieldAttrsSchema = z.object({
  kind: fieldKindSchema,
  /** The heading's `blockId` (Phase 0), or `null` if its target has never resolved. */
  targetBlockId: z.string().nullable().optional(),
  /** The outline level of the target heading, 1-6. Drives a `toc` entry's indent. */
  level: z.number().int().min(1).max(6).optional(),
  /**
   * A `citation` field's sources, by id into `.thepub/sources.json`. More than
   * one when a single parenthetical cites several works — `(Smith 2019; Diaz
   * 2021)` is one field, not two adjacent ones, because a citation engine
   * needs the whole group together to decide things like a shared "ibid."
   */
  sourceIds: z.array(z.string()).optional(),
  /** "pp. 33-40" — a locator within the source, appended after its render. */
  locator: z.string().optional(),
  /** Author-date's "as Smith argues, (2019)" — the name is already in the prose. */
  suppressAuthor: z.boolean().optional()
})
export type FieldAttrs = z.infer<typeof fieldAttrsSchema>

export const FIELD_NODE = 'field'
