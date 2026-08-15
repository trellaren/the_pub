import { z } from 'zod'
import { FORMAT_VERSION } from '../constants.js'
import { keyBetween } from './ordering.js'

/**
 * A beat: one moment of the story.
 *
 * The timeline and the storyboard are two orderings of *the same* records, not
 * two kinds of record. A storyboard card is a scene in manuscript order; a
 * timeline entry is that scene at the point it happens in the story's own
 * chronology. Those orders differ exactly when there is a flashback — which is
 * precisely why an author wants both views, and why splitting them into two
 * models would mean maintaining the same scene twice.
 */
export const beatStatuses = ['outline', 'draft', 'revised', 'done'] as const
export const beatStatusSchema = z.enum(beatStatuses)
export type BeatStatus = z.infer<typeof beatStatusSchema>

/**
 * When a beat happens *in the story*.
 *
 * `label` is whatever the author writes — "Day 3", "Third Age 2941",
 * "1917-04-02" — because invented calendars are the norm and a date picker
 * would be wrong for most manuscripts. `sort` is the key the timeline actually
 * orders by: derived from the label when it can be, and otherwise set by
 * dragging. Keeping them separate is what lets an unparseable label still sit
 * exactly where the author put it.
 */
export const storyMomentSchema = z.object({
  label: z.string().default(''),
  sort: z.number().nullable().default(null)
})
export type StoryMoment = z.infer<typeof storyMomentSchema>

export const beatSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().default(''),
  when: storyMomentSchema.prefault({}),
  /** The scene this beat covers. Null until the author links one. */
  docId: z.string().nullable().default(null),
  blockIndex: z.number().int().nullable().default(null),
  /** Storyboard column: an act, a part, whatever the author calls it. */
  columnId: z.string(),
  /** Position within the column — the manuscript order. Fractional by design. */
  order: z.number().default(0),
  /** Characters and locations present. Ids, so a rename never reaches here. */
  entityIds: z.array(z.string()).default(() => []),
  status: beatStatusSchema.default('outline'),
  color: z.string().optional(),
  created: z.string(),
  modified: z.string()
})
export type Beat = z.infer<typeof beatSchema>

export const boardColumnSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().default(0)
})
export type BoardColumn = z.infer<typeof boardColumnSchema>

export const beatFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  columns: z.array(boardColumnSchema).default(() => defaultColumns()),
  beats: z.array(beatSchema).default(() => [])
})
export type BeatFile = z.infer<typeof beatFileSchema>

/** Three acts to start with, because a blank board tells an author nothing. */
export function defaultColumns(): BoardColumn[] {
  return [
    { id: 'act-1', name: 'Act I', order: 0 },
    { id: 'act-2', name: 'Act II', order: 1 },
    { id: 'act-3', name: 'Act III', order: 2 }
  ]
}

export const EMPTY_BEAT_FILE: BeatFile = {
  formatVersion: FORMAT_VERSION,
  columns: defaultColumns(),
  beats: []
}

/**
 * Derive a sort key from a written moment, or `null` when it cannot be read.
 *
 * Deliberately narrow. It handles the two forms that are unambiguous — a real
 * date, and a label containing exactly one number ("Day 3", "Year 12") — and
 * declines everything else rather than guessing. A wrong key silently reorders
 * an author's story, which is far worse than no key at all: an undated beat
 * simply keeps the position it was given.
 */
export function parseMoment(label: string): number | null {
  const trimmed = label.trim()
  if (!trimmed) return null

  // A full date sorts by its real instant, so eras and calendars stay ordered.
  if (/^-?\d{1,6}-\d{1,2}-\d{1,2}([T ].*)?$/.test(trimmed)) {
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) return parsed
  }

  const numbers = trimmed.match(/-?\d+(?:\.\d+)?/g)
  // Two numbers ("Day 3, Year 12") are ambiguous about which one ranks.
  if (numbers?.length === 1) return Number(numbers[0])
  return null
}

/**
 * Re-exported, not defined here.
 *
 * It moved to `ordering.ts` when the manuscript binder needed the same keys for
 * chapters within a part. Kept exported from this module so every existing
 * importer — the storyboard, the timeline and their tests — is untouched.
 */
export { keyBetween } from './ordering.js'

/** Board order: within one column, by `order`, ties broken stably by id. */
export function beatsInColumn(beats: readonly Beat[], columnId: string): Beat[] {
  return beats
    .filter((beat) => beat.columnId === columnId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/**
 * Chronological order: dated beats by their key, then undated ones in board
 * order at the end.
 *
 * Undated beats go last rather than first so that adding a beat without a date
 * never silently pushes it in front of the story so far.
 */
export function beatsInChronology(beats: readonly Beat[]): Beat[] {
  const dated = beats.filter((beat) => beat.when.sort !== null)
  const undated = beats.filter((beat) => beat.when.sort === null)
  dated.sort((a, b) => a.when.sort! - b.when.sort! || a.order - b.order || a.id.localeCompare(b.id))
  undated.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return [...dated, ...undated]
}

/**
 * Where a beat dropped at `index` of `columnId` belongs.
 *
 * `index` counts positions in the column as it looks *without* the beat being
 * moved, which is what a drop indicator between two cards means.
 */
export function placeInColumn(
  beats: readonly Beat[],
  movingId: string,
  columnId: string,
  index: number
): { columnId: string; order: number } {
  const others = beatsInColumn(beats, columnId).filter((beat) => beat.id !== movingId)
  const clamped = Math.max(0, Math.min(index, others.length))
  const before = clamped > 0 ? others[clamped - 1]!.order : null
  const after = clamped < others.length ? others[clamped]!.order : null
  return { columnId, order: keyBetween(before, after) }
}

/** The same, for a drop into the chronological list. */
export function placeInChronology(
  beats: readonly Beat[],
  movingId: string,
  index: number
): number | null {
  const others = beatsInChronology(beats).filter((beat) => beat.id !== movingId)
  const clamped = Math.max(0, Math.min(index, others.length))
  const before = clamped > 0 ? others[clamped - 1]!.when.sort : null
  const after = clamped < others.length ? others[clamped]!.when.sort : null
  // Dropped past every dated beat and among the undated: it has no date either.
  if (before === null && after === null) return null
  return keyBetween(before, after)
}
