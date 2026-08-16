import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  beatFileSchema,
  beatSchema,
  defaultColumns,
  parseMoment,
  keyBetween,
  beatsInColumn,
  type Beat,
  type BeatFile,
  type BoardColumn
} from '../../shared/model/beat.js'
import { FORMAT_VERSIONS, BEATS_FILE } from '../../shared/constants.js'
import { JsonCollectionService } from './jsonCollectionService.js'

function emptyFile(): BeatFile {
  return { formatVersion: FORMAT_VERSIONS.beats, columns: defaultColumns(), beats: [] }
}

/**
 * Story beats, persisted to `.thepub/beats.json`.
 *
 * `columns` sits alongside `beats` in the file, outside what
 * `JsonCollectionService` models — the same reasoning `EntityService` uses
 * for `dismissed`. Beats are cheap to hold in memory and every view wants all
 * of them at once, so there is no partial-load path.
 */
export class BeatService extends JsonCollectionService<Beat, BeatFile> {
  constructor(adapter: VfsAdapter) {
    super(adapter, {
      file: BEATS_FILE,
      kind: 'beats',
      schema: beatFileSchema,
      empty: emptyFile,
      items: (file) => file.beats,
      withItems: (file, beats) => ({ ...file, beats }),
      idOf: (beat) => beat.id
    })
  }

  async create(input: { title: string; columnId?: string; docId?: string | null }): Promise<Beat> {
    const now = new Date().toISOString()
    const columnId = input.columnId ?? this.cache.columns[0]?.id ?? 'act-1'
    const last = beatsInColumn(this.items(), columnId).at(-1)
    const beat = beatSchema.parse({
      id: ulid(),
      title: input.title,
      columnId,
      docId: input.docId ?? null,
      // New beats land at the end of their column rather than the top: a board
      // is written forwards.
      order: keyBetween(last?.order ?? null, null),
      created: now,
      modified: now
    })
    this.upsert(beat)
    await this.flush()
    return structuredClone(beat)
  }

  async save(incoming: Beat): Promise<Beat> {
    const existing = this.get(incoming.id)
    const beat = beatSchema.parse({
      ...incoming,
      when: deriveMoment(incoming.when, existing?.when),
      created: existing?.created ?? incoming.created,
      modified: new Date().toISOString()
    })
    this.upsert(beat)
    await this.flush()
    return structuredClone(beat)
  }

  async remove(id: string): Promise<void> {
    this.deleteById(id)
    await this.flush()
  }

  async saveColumns(columns: BoardColumn[]): Promise<BoardColumn[]> {
    const nextColumns = columns.map((column, index) => ({ ...column, order: index }))
    // A column can be renamed or reordered freely, but deleting one would
    // orphan its beats, so they follow it to the first surviving column.
    const surviving = new Set(nextColumns.map((column) => column.id))
    const fallback = nextColumns[0]?.id
    const beats = fallback
      ? this.items().map((beat) => (surviving.has(beat.columnId) ? beat : { ...beat, columnId: fallback }))
      : this.items()
    this.cache = { ...this.cache, columns: nextColumns, beats }
    await this.flush()
    return structuredClone(this.cache.columns)
  }
}

/**
 * Keep the sort key in step with the label the author typed.
 *
 * A parseable label always wins, so editing "Day 3" to "Day 9" moves the beat.
 * An unparseable one keeps whatever key it had — usually one assigned by
 * dragging — because the alternative is a hand-placed beat jumping to the end
 * of the timeline the moment its label is edited.
 */
export function deriveMoment(
  incoming: { label: string; sort: number | null },
  previous?: { label: string; sort: number | null }
): { label: string; sort: number | null } {
  const parsed = parseMoment(incoming.label)
  if (parsed !== null) return { label: incoming.label, sort: parsed }
  // An explicit key set by this write (a drag) is respected as given.
  if (incoming.sort !== null && incoming.sort !== previous?.sort) return incoming
  return { label: incoming.label, sort: incoming.sort ?? previous?.sort ?? null }
}
