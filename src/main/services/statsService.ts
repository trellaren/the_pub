import type { VfsAdapter } from '../vfs/types.js'
import { statsFileSchema, EMPTY_STATS_FILE, type StatsFile, type DayStat } from '../../shared/model/stats.js'
import { migrate } from '../../shared/model/migrate.js'
import type { AuthorProfile } from '../../shared/model/author.js'
import { STATS_DIR, STATS_SAVE_DEBOUNCE_MS } from '../../shared/constants.js'

interface Delta {
  date: string
  docId: string
  added: number
  removed: number
  net: number
  minutes: number
}

/**
 * Daily writing rollups, one file per author. Mirrors `NoteService`'s shape —
 * load, debounced flush — but the write path is accumulation, not replace:
 * the renderer reports deltas (word-count changes, active minutes) as they
 * happen, and this service folds them into the day's row before flushing.
 *
 * Single-writer by construction, the same reasoning as `ReviewService`: this
 * only ever reads and writes `this.me().id`'s own file.
 */
export class StatsService {
  private file: StatsFile | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(
    private readonly adapter: VfsAdapter,
    private readonly me: () => AuthorProfile
  ) {}

  private pathFor(authorId: string): string {
    return `${STATS_DIR}/${authorId}.json`
  }

  private async load(): Promise<StatsFile> {
    if (this.file) return this.file
    const path = this.pathFor(this.me().id)
    const existing = await this.adapter.stat(path)
    if (!existing) {
      this.file = structuredClone(EMPTY_STATS_FILE)
      return this.file
    }
    try {
      const raw = await this.adapter.readFile(path)
      const { value } = migrate('stats', JSON.parse(raw.toString('utf8')))
      this.file = statsFileSchema.parse(value)
    } catch {
      // An unreadable rollup is not worth a project's writing history — start
      // fresh rather than block every future day on a corrupt one. Unlike
      // notes, there is no per-day content a person would recognise and want
      // back byte-for-byte; the file is regenerated from now on.
      await this.adapter.rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {})
      this.file = structuredClone(EMPTY_STATS_FILE)
    }
    return this.file
  }

  /** Every recorded day, oldest first. */
  async all(): Promise<DayStat[]> {
    const file = await this.load()
    return structuredClone(file.days).sort((a, b) => a.date.localeCompare(b.date))
  }

  /** Fold one word-count/active-minutes delta into its day, scheduling a flush. */
  async record(delta: Delta): Promise<void> {
    const file = await this.load()
    const index = file.days.findIndex((day) => day.date === delta.date)
    if (index === -1) {
      file.days.push({
        date: delta.date,
        added: delta.added,
        removed: delta.removed,
        net: delta.net,
        minutes: delta.minutes,
        byDoc: delta.net !== 0 ? { [delta.docId]: delta.net } : {}
      })
    } else {
      const day = file.days[index]!
      file.days[index] = {
        ...day,
        added: day.added + delta.added,
        removed: day.removed + delta.removed,
        net: day.net + delta.net,
        // Minutes for the day are reported as a running total by the caller
        // (see `renderer/stats`), so the latest report simply replaces it
        // rather than summing — summing would double-count every extension
        // of the same open sitting.
        minutes: Math.max(day.minutes, delta.minutes),
        byDoc:
          delta.net !== 0 ? { ...day.byDoc, [delta.docId]: (day.byDoc[delta.docId] ?? 0) + delta.net } : day.byDoc
      }
    }
    this.dirty = true
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, STATS_SAVE_DEBOUNCE_MS)
    this.flushTimer.unref?.()
  }

  /** Write now, unconditionally on a pending change. Called on project close. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.dirty || !this.file) return
    this.dirty = false
    await this.adapter.mkdir(STATS_DIR).catch(() => {})
    await this.adapter.writeFileAtomic(
      this.pathFor(this.me().id),
      Buffer.from(`${JSON.stringify(this.file, null, 2)}\n`, 'utf8')
    )
  }
}
