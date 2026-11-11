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

  let json: unknown
  try {
    json = JSON.parse(raw.toString('utf8'))
  } catch {
    return quarantine(adapter, file, empty)
  }
  const { value, tooNew } = migrate(kind, json)
  if (tooNew) {
    const shown = schema.safeParse(value)
    return { value: shown.success ? shown.data : empty(), missing: false, tooNew: true }
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) return quarantine(adapter, file, empty)
  return { value: parsed.data, missing: false, tooNew: false }
}

async function quarantine<T>(adapter: VfsAdapter, file: string, empty: () => T): Promise<VersionedRead<T>> {
  const target = `${file}.corrupt-${Date.now()}`
  await adapter.rename(file, target)
  return { value: empty(), missing: false, tooNew: false, quarantinedTo: target }
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
