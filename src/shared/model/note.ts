import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'
import { pmDocSchema, EMPTY_DOC } from './document.js'

/**
 * A note attached to a range of prose.
 *
 * The body lives here, in a sidecar file — never in the `.pubdoc` it
 * annotates. The reasoning is the one already recorded for why entity notes
 * left the manifest, inverted: a note must not be counted by `countWords`,
 * must not appear in `extractPlainText` (which feeds search and AI context),
 * must not pollute the History panel's diff, and must not have to survive a
 * Word round-trip as an alien node. Only the mark's `anchorId` lives in the
 * document; everything else lives here, addressed by it.
 */
export const noteSchema = z.object({
  id: z.string(),
  docId: z.string(),
  anchorId: z.string(),
  body: pmDocSchema.default(() => structuredClone(EMPTY_DOC)),
  resolved: z.boolean().default(false),
  /**
   * Whether `anchorId` could be found in the document as of the last
   * reconcile. An orphaned note is never deleted — only the mark is gone,
   * not the thought — and stays addressable by `anchorText` until it is
   * either re-attached or removed by hand.
   */
  orphaned: z.boolean().default(false),
  /**
   * The anchor's own text, as of the last time it was found. What a re-attach
   * search looks for — the same recovery the mention scanner already relies
   * on, in the same normalised-text coordinate space `findAnchorLocations`
   * reports in.
   */
  anchorText: z.string(),
  /** Which top-level block the anchor was in, as of the last time it was found. */
  blockIndex: z.number().int(),
  created: z.string(),
  modified: z.string()
})
export type Note = z.infer<typeof noteSchema>

/** One document's worth of notes: `.thepub/notes/<docId>.json`. */
export const noteFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.notes),
  notes: z.array(noteSchema).default(() => [])
})
export type NoteFile = z.infer<typeof noteFileSchema>

export const EMPTY_NOTE_FILE: NoteFile = { formatVersion: FORMAT_VERSIONS.notes, notes: [] }
