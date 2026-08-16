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
import { BEATS_FILE, PUB_DIR, FORMAT_VERSIONS } from '../../shared/constants.js'

function emptyFile(): BeatFile {
  return { formatVersion: FORMAT_VERSIONS.beats, columns: defaultColumns(), beats: [] }
}

/**
 * Story beats, persisted to `.thepub/beats.json`.
 *
 * Same shape as EntityService and for the same reasons: this process is the
 * file's only writer, it never re-reads on a watcher event, and a corrupt file
 * is set aside rather than overwritten. Beats are cheap to hold in memory and
 * every view wants all of them at once, so there is no partial-load path.
 */
export class BeatService {
  private cache: BeatFile = emptyFile()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly adapter: VfsAdapter) {}

  async load(): Promise<BeatFile> {
    const existing = await this.adapter.stat(BEATS_FILE)
    if (!existing) {
      this.cache = emptyFile()
      return this.snapshot()
    }
    try {
      const raw = await this.adapter.readFile(BEATS_FILE)
      this.cache = beatFileSchema.parse(JSON.parse(raw.toString('utf8')))
    } catch {
      await this.adapter.rename(BEATS_FILE, `${BEATS_FILE}.corrupt-${Date.now()}`).catch(() => {})
      this.cache = emptyFile()
    }
    return this.snapshot()
  }

  snapshot(): BeatFile {
    return structuredClone(this.cache)
  }

  get(id: string): Beat | null {
    return this.cache.beats.find((beat) => beat.id === id) ?? null
  }

  async create(input: { title: string; columnId?: string; docId?: string | null }): Promise<Beat> {
    const now = new Date().toISOString()
    const columnId = input.columnId ?? this.cache.columns[0]?.id ?? 'act-1'
    const last = beatsInColumn(this.cache.beats, columnId).at(-1)
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
    this.cache.beats = [...this.cache.beats, beat]
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
    this.cache.beats = existing
      ? this.cache.beats.map((candidate) => (candidate.id === beat.id ? beat : candidate))
      : [...this.cache.beats, beat]
    await this.flush()
    return structuredClone(beat)
  }

  async remove(id: string): Promise<void> {
    this.cache.beats = this.cache.beats.filter((beat) => beat.id !== id)
    await this.flush()
  }

  async saveColumns(columns: BoardColumn[]): Promise<BoardColumn[]> {
    this.cache.columns = columns.map((column, index) => ({ ...column, order: index }))
    // A column can be renamed or reordered freely, but deleting one would
    // orphan its beats, so they follow it to the first surviving column.
    const surviving = new Set(this.cache.columns.map((column) => column.id))
    const fallback = this.cache.columns[0]?.id
    if (fallback) {
      this.cache.beats = this.cache.beats.map((beat) =>
        surviving.has(beat.columnId) ? beat : { ...beat, columnId: fallback }
      )
    }
    await this.flush()
    return structuredClone(this.cache.columns)
  }

  private async flush(): Promise<void> {
    const file: BeatFile = { ...this.cache, formatVersion: FORMAT_VERSIONS.beats }
    this.queue = this.queue.then(async () => {
      await this.adapter.mkdir(PUB_DIR).catch(() => {})
      await this.adapter.writeFileAtomic(
        BEATS_FILE,
        Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
      )
    })
    await this.queue
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
