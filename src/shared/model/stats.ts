import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'

/**
 * One local day's writing.
 *
 * A rollup, not an event log: the unit anyone asks about is a day, and a
 * bounded per-day row is what keeps this file small after a year of writing.
 * See `docs/phase-13-plan.md`'s "why the data does not already exist".
 */
export const dayStatSchema = z.object({
  /** 'YYYY-MM-DD', the writer's local day — not UTC. See `localDayKey`. */
  date: z.string(),
  /** Gross words added, summed across every debounced change that day. */
  added: z.number().int().default(0),
  /** Gross words removed, summed the same way. A cut is not a zero. */
  removed: z.number().int().default(0),
  /** `added - removed`, stored rather than derived so a reader never has to. */
  net: z.number().int().default(0),
  /** Active minutes, the sum of writing sessions — not wall-clock time open. */
  minutes: z.number().int().default(0),
  /** docId → net words that day, for the per-document breakdown. */
  byDoc: z.record(z.string(), z.number().int()).default(() => ({}))
})
export type DayStat = z.infer<typeof dayStatSchema>

/** One author's rollup file: `.thepub/stats/<authorId>.json`. */
export const statsFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.stats),
  days: z.array(dayStatSchema).default(() => [])
})
export type StatsFile = z.infer<typeof statsFileSchema>

export const EMPTY_STATS_FILE: StatsFile = { formatVersion: FORMAT_VERSIONS.stats, days: [] }

export function emptyDayStat(date: string): DayStat {
  return { date, added: 0, removed: 0, net: 0, minutes: 0, byDoc: {} }
}
