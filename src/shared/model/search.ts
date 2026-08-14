import { z } from 'zod'

export const searchQuerySchema = z.object({
  text: z.string(),
  limit: z.number().int().min(1).max(500).default(200),
  /** Restrict to a project-relative directory prefix. */
  pathPrefix: z.string().optional(),
  matchCase: z.boolean().default(false),
  wholeWord: z.boolean().default(false)
})
export type SearchQuery = z.infer<typeof searchQuerySchema>

export const searchHitSchema = z.object({
  docId: z.string(),
  path: z.string(),
  title: z.string(),
  /** Index of the top-level block the hit is in — the jump-to target. */
  blockIndex: z.number().int(),
  /** Plain text of the block, trimmed around the match. */
  snippet: z.string(),
  /** Character offsets of matches within `snippet`. */
  ranges: z.array(z.object({ start: z.number().int(), end: z.number().int() })).default([]),
  score: z.number(),
  kind: z.enum(['content', 'filename'])
})
export type SearchHit = z.infer<typeof searchHitSchema>

export const indexProgressSchema = z.object({
  done: z.number().int(),
  total: z.number().int(),
  indexing: z.boolean()
})
export type IndexProgress = z.infer<typeof indexProgressSchema>
