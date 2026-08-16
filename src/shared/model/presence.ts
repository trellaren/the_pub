import { z } from 'zod'
import { FORMAT_VERSIONS, PRESENCE_TTL_MS } from '../constants.js'

/**
 * "Marta has this chapter open."
 *
 * A heartbeat, not a claim. It carries the author's display name and colour
 * alongside the id so a collaborator can be shown before — or without — the
 * project's author registry having caught up with them.
 */
export const presenceBeatSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.presence),
  authorId: z.string(),
  name: z.string().default(''),
  color: z.string().default(''),
  docId: z.string().default(''),
  /** When the beat was written. Compared against the TTL, never trusted as an order. */
  at: z.string().default('')
})
export type PresenceBeat = z.infer<typeof presenceBeatSchema>

/**
 * Whether a beat still counts.
 *
 * A beat from the future is treated as live rather than discarded: unsynchronised
 * clocks across a shared folder are the ordinary case, and refusing to show a
 * collaborator because their laptop is two minutes fast would be a bug nobody
 * could diagnose from the UI.
 */
export function isLive(beat: PresenceBeat, now = Date.now()): boolean {
  const at = Date.parse(beat.at)
  if (Number.isNaN(at)) return false
  return now - at < PRESENCE_TTL_MS
}
