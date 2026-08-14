import { z } from 'zod'

export const snapshotSchema = z.object({
  docId: z.string(),
  /** ISO timestamp; also the snapshot's filename stem. */
  timestamp: z.string(),
  size: z.number().int(),
  wordCount: z.number().int()
})
export type Snapshot = z.infer<typeof snapshotSchema>
