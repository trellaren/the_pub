import type { ZodType } from 'zod'
import type { VfsAdapter } from '../vfs/types.js'
import type { FileKind } from '../../shared/constants.js'
import { migrate } from '../../shared/model/migrate.js'

export interface VersionedRead<T> {
  value: T
  /** Absent on disk; `value` is `empty()`. */
  missing: boolean
  /** Written by a newer build: show `value`, never write it back. */
  tooNew: boolean
  /** Path the unparseable original was set aside to, when it was. */
  quarantinedTo?: string
  /** The file's mtime as stat'd before reading, when the backend reports one. */
  mtime?: number
}

/**
 * The one load path for a project's versioned JSON files.
 *
 * Only content that was read and then failed to parse is quarantined. A failed
 * *read* — an unplugged drive, a dropped SFTP session — propagates instead:
 * renaming a file because the network blinked, then saving an empty one in
 * its place, is the loss this exists to prevent.
 */
export async function readVersionedJson<T>(
  adapter: VfsAdapter,
  file: string,
  kind: FileKind,
  schema: ZodType<T>,
  empty: () => T
): Promise<VersionedRead<T>> {
  const existing = await adapter.stat(file)
  if (!existing) return { value: empty(), missing: true, tooNew: false }
  const raw = await adapter.readFile(file)
  const mtime = existing.mtime

  let json: unknown
  try {
    json = JSON.parse(raw.toString('utf8'))
  } catch {
    return quarantine(adapter, file, empty)
  }
  const { value, tooNew } = migrate(kind, json)
  if (tooNew) {
    const shown = schema.safeParse(value)
    return { value: shown.success ? shown.data : empty(), missing: false, tooNew: true, mtime }
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) return quarantine(adapter, file, empty)
  return { value: parsed.data, missing: false, tooNew: false, mtime }
}

async function quarantine<T>(adapter: VfsAdapter, file: string, empty: () => T): Promise<VersionedRead<T>> {
  const target = `${file}.corrupt-${Date.now()}`
  await adapter.rename(file, target)
  return { value: empty(), missing: false, tooNew: false, quarantinedTo: target }
}

export interface Baseline<TFile> {
  /** The file as this process last read or wrote it. */
  value: TFile
  mtime?: number
  /** It did not exist then, so any file there now is someone else's. */
  missing?: boolean
}

export interface MergeShape<TFile, TItem> {
  items: (file: TFile) => TItem[]
  withItems: (file: TFile, items: TItem[]) => TFile
  idOf: (item: TItem) => string
}

/**
 * Fold this process's edits since `baseline` onto what is on disk now, when
 * something else — a sync client, a second machine — rewrote the file since
 * it was read. Per item, last writer wins; without this, a cached whole-file
 * write would silently undo every item the other writer added or changed.
 *
 * Returns `current` untouched when the file has not moved.
 */
export async function mergeWithDisk<TFile, TItem>(
  adapter: VfsAdapter,
  file: string,
  kind: FileKind,
  schema: ZodType<TFile>,
  empty: () => TFile,
  baseline: Baseline<TFile> | undefined,
  current: TFile,
  shape: MergeShape<TFile, TItem>
): Promise<{ value: TFile; tooNew: boolean }> {
  const stat = await adapter.stat(file)
  if (!stat || !baseline) return { value: current, tooNew: false }
  if (!baseline.missing && (stat.mtime === undefined || stat.mtime === baseline.mtime)) {
    return { value: current, tooNew: false }
  }
  const fresh = await readVersionedJson(adapter, file, kind, schema, empty)
  if (fresh.tooNew) return { value: fresh.value, tooNew: true }
  const merged = mergeById(shape.items(baseline.value), shape.items(current), shape.items(fresh.value), shape.idOf)
  return { value: shape.withItems(current, merged), tooNew: false }
}

export function mergeById<T>(
  baseline: readonly T[],
  current: readonly T[],
  fresh: readonly T[],
  idOf: (item: T) => string
): T[] {
  const before = new Map(baseline.map((item) => [idOf(item), JSON.stringify(item)]))
  const kept = new Set(current.map(idOf))
  const removed = new Set([...before.keys()].filter((id) => !kept.has(id)))
  const changed = new Map(
    current.filter((item) => before.get(idOf(item)) !== JSON.stringify(item)).map((item) => [idOf(item), item])
  )
  const merged = fresh.filter((item) => !removed.has(idOf(item))).map((item) => changed.get(idOf(item)) ?? item)
  const present = new Set(merged.map(idOf))
  // An item we edited that the other writer deleted comes back: an edit is
  // work, and a deletion can be repeated where lost prose cannot be retyped.
  for (const [id, item] of changed) if (!present.has(id)) merged.push(item)
  return merged
}

/**
 * Runs tasks one at a time, in submission order. A task that rejects fails its
 * own caller only: the next task still runs, where a bare `queue = queue.then(...)`
 * chain would stay rejected and refuse every save for the rest of the session.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => {})
    return next
  }

  /** Settles once everything submitted so far has. */
  idle(): Promise<void> {
    return this.tail.then(() => {})
  }
}

/** A `SerialQueue` per key, for services that keep one file per document. */
export class KeyedSerialQueue {
  private readonly queues = new Map<string, SerialQueue>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(key)
    if (!queue) {
      queue = new SerialQueue()
      this.queues.set(key, queue)
    }
    return queue.run(task)
  }
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
