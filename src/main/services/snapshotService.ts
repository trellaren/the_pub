import type { VfsAdapter } from '../vfs/types.js'
import type { Snapshot } from '../../shared/model/snapshot.js'
import { pubDocumentSchema, type PubDocument } from '../../shared/model/document.js'
import { SNAPSHOTS_DIR, SNAPSHOT_MIN_INTERVAL_MS, SNAPSHOT_MAX_PER_DOC } from '../../shared/constants.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/**
 * Version history for documents.
 *
 * Autosave writes constantly, so snapshotting every save would be useless noise.
 * Instead the *previous* content is archived at most once per interval, giving a
 * thinning trail of recoverable versions rather than a keystroke log.
 */
export class SnapshotService {
  private lastSnapshotAt = new Map<string, number>()

  constructor(private readonly adapter: VfsAdapter) {}

  private dirFor(docId: string): string {
    return `${SNAPSHOTS_DIR}/${docId}`
  }

  /** Returns true if a snapshot was written. */
  async maybeSnapshot(previous: PubDocument, now = Date.now()): Promise<boolean> {
    const last = this.lastSnapshotAt.get(previous.docId)
    if (last !== undefined && now - last < SNAPSHOT_MIN_INTERVAL_MS) return false
    if (last === undefined) {
      // First save this session: only snapshot if the newest stored one is old
      // enough, so reopening a project doesn't spam a snapshot per document.
      const existing = await this.list(previous.docId)
      const newest = existing.at(-1)
      if (newest && now - Date.parse(newest.timestamp) < SNAPSHOT_MIN_INTERVAL_MS) {
        this.lastSnapshotAt.set(previous.docId, Date.parse(newest.timestamp))
        return false
      }
    }
    await this.write(previous, now)
    this.lastSnapshotAt.set(previous.docId, now)
    return true
  }

  private async write(document: PubDocument, now: number): Promise<void> {
    const timestamp = new Date(now).toISOString().replace(/[:.]/g, '-')
    const target = `${this.dirFor(document.docId)}/${timestamp}.json`
    await this.adapter.writeFileAtomic(target, Buffer.from(JSON.stringify(document), 'utf8'))
    await this.prune(document.docId, now)
  }

  async list(docId: string): Promise<Snapshot[]> {
    let entries
    try {
      entries = await this.adapter.list(this.dirFor(docId))
    } catch {
      return []
    }
    const snapshots: Snapshot[] = []
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      snapshots.push({
        docId,
        timestamp: fromStamp(entry.name.replace(/\.json$/, '')),
        size: entry.size ?? 0,
        wordCount: 0
      })
    }
    return snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }

  async read(docId: string, timestamp: string): Promise<PubDocument> {
    const stamp = timestamp.replace(/[:.]/g, '-')
    const raw = await this.adapter.readFile(`${this.dirFor(docId)}/${stamp}.json`)
    return pubDocumentSchema.parse(JSON.parse(raw.toString('utf8')))
  }

  /**
   * Thin out history: everything from the last day, hourly for the last week,
   * daily before that, and never more than `SNAPSHOT_MAX_PER_DOC` in total.
   */
  async prune(docId: string, now = Date.now()): Promise<void> {
    const snapshots = await this.list(docId)
    const keep = selectSnapshotsToKeep(
      snapshots.map((snapshot) => Date.parse(snapshot.timestamp)),
      now
    )
    for (const snapshot of snapshots) {
      if (keep.has(Date.parse(snapshot.timestamp))) continue
      const stamp = snapshot.timestamp.replace(/[:.]/g, '-')
      await this.adapter.delete(`${this.dirFor(docId)}/${stamp}.json`).catch(() => {})
    }
  }
}

/** Snapshot filenames replace `:` and `.` (illegal on Windows) — undo that. */
function fromStamp(stamp: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp)
  if (!match) return stamp
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
}

/**
 * Pure retention policy, split out so it can be tested without touching disk.
 * Keeps the newest snapshot within each bucket the age tier defines.
 */
export function selectSnapshotsToKeep(timestamps: number[], now: number): Set<number> {
  const sorted = [...timestamps].sort((a, b) => b - a)
  const keep = new Set<number>()
  const bucketsSeen = new Set<string>()
  for (const timestamp of sorted) {
    const age = now - timestamp
    let bucket: string
    if (age <= DAY) bucket = `exact:${timestamp}`
    else if (age <= WEEK) bucket = `hour:${Math.floor(timestamp / HOUR)}`
    else bucket = `day:${Math.floor(timestamp / DAY)}`
    if (bucketsSeen.has(bucket)) continue
    bucketsSeen.add(bucket)
    keep.add(timestamp)
    if (keep.size >= SNAPSHOT_MAX_PER_DOC) break
  }
  return keep
}
