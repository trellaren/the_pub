import { z } from 'zod'

/**
 * Where a name occurs in the prose.
 *
 * Every offset and ordinal in this file is in *normalised block-text*
 * coordinates — the same space `SearchHit.snippet` and `SearchHit.ranges`
 * already use, produced by `normalizeBlockText`. Raw ProseMirror positions
 * exist only inside the text walker and inside mark application.
 */
export const mentionRangeSchema = z.object({
  start: z.number().int(),
  end: z.number().int()
})
export type MentionRange = z.infer<typeof mentionRangeSchema>

/**
 * Enough to find one occurrence again and write a mark over it.
 *
 * `ordinal` — the n-th occurrence of this exact surface form within the block —
 * rather than a character offset, because the offset moves with every keystroke
 * earlier in the paragraph while the ordinal survives ordinary editing around
 * it. `surface` is the text as it actually appears, which may be an alias.
 */
export const mentionRefSchema = z.object({
  entityId: z.string(),
  docId: z.string(),
  blockIndex: z.number().int(),
  ordinal: z.number().int(),
  surface: z.string()
})
export type MentionRef = z.infer<typeof mentionRefSchema>

/**
 * One occurrence as found in a document, before it reaches the database.
 *
 * `confirmed` distinguishes the two sources: a real `mention` mark written into
 * the `.pubdoc` (authoritative — the author decided), versus a name-scan
 * suggestion, which exists only in the index and never touches disk.
 */
export const mentionOccurrenceSchema = z.object({
  entityId: z.string(),
  blockIndex: z.number().int(),
  start: z.number().int(),
  end: z.number().int(),
  ordinal: z.number().int(),
  surface: z.string(),
  confirmed: z.boolean()
})
export type MentionOccurrence = z.infer<typeof mentionOccurrenceSchema>

/**
 * A backlink row. Deliberately shaped like `SearchHit` — same `snippet` plus
 * `ranges` pair — so the snippet renderer and the jump-to-paragraph flow are
 * shared with global search rather than cloned.
 */
export const mentionHitSchema = z.object({
  entityId: z.string(),
  docId: z.string(),
  path: z.string(),
  title: z.string(),
  blockIndex: z.number().int(),
  ordinal: z.number().int(),
  surface: z.string(),
  confirmed: z.boolean(),
  snippet: z.string(),
  /** Offsets of the mention within `snippet`, not within the block. */
  ranges: z.array(mentionRangeSchema).default(() => [])
})
export type MentionHit = z.infer<typeof mentionHitSchema>

/** Per-record counts for the badge on a list row. */
export const mentionCountsSchema = z.object({
  confirmed: z.number().int(),
  unconfirmed: z.number().int(),
  documents: z.number().int()
})
export type MentionCounts = z.infer<typeof mentionCountsSchema>

export const mentionQuerySchema = z.object({
  entityId: z.string(),
  /** Omit for both; `true` for confirmed only, `false` for suggestions only. */
  confirmed: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).default(200)
})
export type MentionQuery = z.infer<typeof mentionQuerySchema>

/** Attributes carried by the `mention` mark in the document JSON. */
export const mentionAttrsSchema = z.object({
  entityId: z.string(),
  /** Duplicated onto the mark so the editor can colour and route a mention
   *  without a lookup, and so a mention to a deleted record still renders. */
  entityKind: z.string().optional()
})
export type MentionAttrs = z.infer<typeof mentionAttrsSchema>

/**
 * The mark is named `mention`, not `characterMention`: it covers locations too,
 * and the mark type string is written into every `.pubdoc` that uses it, so it
 * is expensive to rename later.
 */
export const MENTION_MARK = 'mention'
