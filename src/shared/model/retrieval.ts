import { z } from 'zod'

/**
 * How much of the manuscript can be searched by meaning.
 *
 * Reported rather than assumed, because partial is the normal state: embedding
 * happens in batches against a model that may not be running, so a writer who
 * asks "which chapter mentions the harbour" deserves to know whether they are
 * searching all of their book or a third of it. A silently partial index gives
 * confident, wrong answers.
 */
export const retrievalStatusSchema = z.object({
  /** Blocks with a current vector. */
  embedded: z.number().int().default(0),
  /** Blocks in the project at all. `embedded === total` is a complete index. */
  total: z.number().int().default(0),
  building: z.boolean().default(false),
  /**
   * Why this project cannot be indexed at all right now — no embeddings
   * endpoint, AI switched off — in a sentence a writer can act on. Empty when
   * it can.
   */
  unavailable: z.string().default(''),
  /** What went wrong during the last build, if anything. */
  error: z.string().default('')
})
export type RetrievalStatus = z.infer<typeof retrievalStatusSchema>
