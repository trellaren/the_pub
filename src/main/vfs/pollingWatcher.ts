import type { VfsAdapter, Unwatch } from './types.js'
import type { FileChangeEvent, VfsEntry } from '../../shared/model/vfs.js'
import { IGNORED_DIRS } from '../../shared/constants.js'

export const DEFAULT_POLL_INTERVAL_MS = 15_000

/**
 * Change detection for backends with no native watch (FTP, SFTP, OneDrive
 * without delta). Diffs a recursive mtime scan on an interval so consumers of
 * `VfsAdapter.watch` never have to know whether events are native or polled.
 */
export function pollingWatch(
  adapter: VfsAdapter,
  dir: string,
  onChange: (events: FileChangeEvent[]) => void,
  intervalMs = DEFAULT_POLL_INTERVAL_MS
): Unwatch {
  let previous: Map<string, number> | null = null
  let stopped = false

  const snapshot = async (): Promise<Map<string, number>> => {
    const files = await adapter.walk(dir, IGNORED_DIRS)
    return new Map(files.map((file: VfsEntry) => [file.path, file.mtime ?? 0]))
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    let current: Map<string, number>
    try {
      current = await snapshot()
    } catch {
      return // Transient remote failure; try again next interval.
    }
    if (previous) {
      const events: FileChangeEvent[] = []
      for (const [path, mtime] of current) {
        const before = previous.get(path)
        if (before === undefined) events.push({ type: 'add', path, mtime })
        else if (before !== mtime) events.push({ type: 'change', path, mtime })
      }
      for (const path of previous.keys()) {
        if (!current.has(path)) events.push({ type: 'unlink', path })
      }
      if (events.length > 0 && !stopped) onChange(events)
    }
    previous = current
  }

  // Each tick is scheduled only once the last has finished: on a slow server a
  // walk can outlast the interval, and overlapping walks would both diff
  // against the same `previous` and report one edit twice.
  let timer: ReturnType<typeof setTimeout> | null = null
  const loop = async (): Promise<void> => {
    await tick()
    if (!stopped) timer = setTimeout(() => void loop(), intervalMs)
  }
  void loop()

  return async () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
