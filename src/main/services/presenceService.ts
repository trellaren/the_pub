import type { VfsAdapter } from '../vfs/types.js'
import { migrate } from '../../shared/model/migrate.js'
import {
  presenceBeatSchema,
  type PresenceBeat,
  isLive
} from '../../shared/model/presence.js'
import type { AuthorProfile } from '../../shared/model/author.js'
import { PRESENCE_DIR, PRESENCE_BEAT_MS, FORMAT_VERSIONS } from '../../shared/constants.js'

/**
 * Who else has this project open.
 *
 * Advisory, and deliberately never a lock. There is no server to arbitrate one,
 * a lock file on a synced folder is a lock that outlives the process that took
 * it, and the failure mode of a stale lock — a writer locked out of their own
 * manuscript — is far worse than the failure mode of stale presence, which is a
 * face shown a minute too long.
 *
 * One file per author, so the write path is single-writer for the same reason
 * the review layout is.
 */
export class PresenceService {
  private timer: NodeJS.Timeout | null = null
  private docId = ''

  constructor(
    private readonly adapter: VfsAdapter,
    private readonly me: () => AuthorProfile
  ) {}

  /** Start beating for a document, replacing whatever we were beating for. */
  enter(docId: string): void {
    this.docId = docId
    void this.beat()
    if (this.timer) return
    this.timer = setInterval(() => void this.beat(), PRESENCE_BEAT_MS)
    // Presence must never be the reason the app stays alive.
    this.timer.unref?.()
  }

  async leave(): Promise<void> {
    this.stop()
    // Best-effort: a beat left behind expires on its own, which is why the TTL
    // exists at all.
    await this.adapter.delete(this.pathFor(this.me().id)).catch(() => {})
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.docId = ''
  }

  private pathFor(authorId: string): string {
    return `${PRESENCE_DIR}/${authorId}.json`
  }

  private async beat(): Promise<void> {
    if (!this.docId) return
    const profile = this.me()
    const beat: PresenceBeat = {
      formatVersion: FORMAT_VERSIONS.presence,
      authorId: profile.id,
      name: profile.name,
      color: profile.color,
      docId: this.docId,
      at: new Date().toISOString()
    }
    await this.adapter.mkdir(PRESENCE_DIR).catch(() => {})
    await this.adapter
      .writeFileAtomic(this.pathFor(profile.id), Buffer.from(`${JSON.stringify(beat)}\n`, 'utf8'))
      .catch(() => {})
  }

  /**
   * Everyone but us who is currently live, optionally in one document.
   *
   * Read fresh every time rather than cached: the whole value of this is that it
   * is current, and the cost is a directory of very small files.
   */
  async list(docId?: string): Promise<PresenceBeat[]> {
    const entries = await this.adapter.list(PRESENCE_DIR).catch(() => [])
    const now = Date.now()
    const live: PresenceBeat[] = []
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.path.endsWith('.json')) continue
      try {
        const raw = await this.adapter.readFile(entry.path)
        const { value } = migrate('presence', JSON.parse(raw.toString('utf8')))
        const beat = presenceBeatSchema.parse(value)
        if (beat.authorId === this.me().id) continue
        if (!isLive(beat, now)) continue
        if (docId && beat.docId !== docId) continue
        live.push(beat)
      } catch {
        // A half-written or unreadable beat is not worth a word to anyone.
      }
    }
    return live
  }
}
