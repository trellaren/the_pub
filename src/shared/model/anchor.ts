import { z } from 'zod'

/** Attributes carried by the `anchor` mark in the document JSON. */
export const anchorAttrsSchema = z.object({
  anchorId: z.string()
})
export type AnchorAttrs = z.infer<typeof anchorAttrsSchema>

/**
 * The mark is named `anchor`, not `note` or `comment`: it is the identity a
 * range of text carries, independent of what points at it. A note today, a
 * citation or a comment thread later — all the same mark, so a document never
 * has to be migrated just because a second thing learns to anchor to text.
 *
 * The mark type string is written into every `.pubdoc` that uses it, so like
 * `MENTION_MARK` it is expensive to rename later.
 */
export const ANCHOR_MARK = 'anchor'
