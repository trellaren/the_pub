import { current } from '../runtime.js'
import type { FsChange } from '../mobileFs.js'

type Listener = (path: string) => void

/**
 * The slice of chokidar `LocalAdapter` uses, fed by the in-app filesystem's own
 * change notices. Nothing else writes to that storage, so they are complete.
 */
export interface FSWatcher {
  on(event: FsChange['kind'], listener: Listener): FSWatcher
  close(): Promise<void>
}

export function watch(root: string, options?: { ignored?: (path: string) => boolean }): FSWatcher {
  const listeners = new Map<string, Listener[]>()
  const stop = current().fs.onChange((change) => {
    if (change.path !== root && !change.path.startsWith(`${root}/`)) return
    if (options?.ignored?.(change.path)) return
    for (const listener of listeners.get(change.kind) ?? []) listener(change.path)
  })
  const watcher: FSWatcher = {
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return watcher
    },
    async close() {
      stop()
    }
  }
  return watcher
}
