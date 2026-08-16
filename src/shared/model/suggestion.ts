import { z } from 'zod'

/**
 * Suggested edits, as marks over text.
 *
 * Marks rather than nodes — the rule `mention.ts` and `anchors.ts` already
 * record — because a suggestion is a *property* of a range of prose, not a new
 * kind of thing in the document. A node would break every offset the mention
 * scanner, the search index and the word count are measured in; a mark leaves
 * the text where it is and says something about it.
 *
 * There are two, and the asymmetry is the point:
 *
 * - `insertion` marks text that is really there but not yet accepted.
 * - `deletion` marks text that is **still in the document** and proposed for
 *   removal. A suggestion to delete has to survive until somebody judges it, so
 *   it cannot actually remove anything — which is why rejecting a deletion is
 *   free and accepting one is the destructive direction.
 */
export const suggestionAttrsSchema = z.object({
  /** Who suggested it. An id, never a name — see `author.ts`. */
  authorId: z.string(),
  /** When, so a reviewer's pass can be read in order. */
  at: z.string().default('')
})
export type SuggestionAttrs = z.infer<typeof suggestionAttrsSchema>

/** Written into every `.pubdoc` that carries a suggestion; expensive to rename. */
export const INSERTION_MARK = 'insertion'
export const DELETION_MARK = 'deletion'

export const SUGGESTION_MARKS = [INSERTION_MARK, DELETION_MARK] as const
export type SuggestionMark = (typeof SUGGESTION_MARKS)[number]

export function isSuggestionMark(type: string): type is SuggestionMark {
  return type === INSERTION_MARK || type === DELETION_MARK
}
