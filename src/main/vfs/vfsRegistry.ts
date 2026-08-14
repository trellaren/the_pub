import { fileURLToPath } from 'node:url'
import type { VfsAdapter, Unwatch } from './types.js'
import type { FileChangeEvent } from '../../shared/model/vfs.js'
import { LocalAdapter } from './localAdapter.js'
import { pollingWatch } from './pollingWatcher.js'

/**
 * Wraps an adapter so `watch()` works even when the backend has none, letting
 * every consumer call `watch` unconditionally.
 */
class WatchableAdapter implements VfsAdapter {
  constructor(private readonly inner: VfsAdapter) {}

  get caps(): VfsAdapter['caps'] {
    return this.inner.caps
  }
  get root(): string {
    return this.inner.root
  }

  list: VfsAdapter['list'] = (dir) => this.inner.list(dir)
  stat: VfsAdapter['stat'] = (path) => this.inner.stat(path)
  readFile: VfsAdapter['readFile'] = (path) => this.inner.readFile(path)
  writeFile: VfsAdapter['writeFile'] = (path, data) => this.inner.writeFile(path, data)
  writeFileAtomic: VfsAdapter['writeFileAtomic'] = (path, data) => this.inner.writeFileAtomic(path, data)
  mkdir: VfsAdapter['mkdir'] = (path) => this.inner.mkdir(path)
  rename: VfsAdapter['rename'] = (from, to) => this.inner.rename(from, to)
  delete: VfsAdapter['delete'] = (path, options) => this.inner.delete(path, options)
  walk: VfsAdapter['walk'] = (dir, ignored) => this.inner.walk(dir, ignored)
  dispose: VfsAdapter['dispose'] = () => this.inner.dispose()

  async watch(dir: string, onChange: (events: FileChangeEvent[]) => void): Promise<Unwatch> {
    if (this.inner.caps.watch) return this.inner.watch(dir, onChange)
    return pollingWatch(this.inner, dir, onChange)
  }
}

/** Parse a project URI into a scheme and a backend-specific location. */
export function parseUri(uri: string): { scheme: string; location: string } {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri)
  if (!match) return { scheme: 'local', location: uri }
  const scheme = match[1]!.toLowerCase()
  if (scheme === 'file') return { scheme: 'local', location: fileURLToPath(uri) }
  return { scheme, location: uri.slice(match[0].length) }
}

/**
 * Build the adapter for a project URI. Remote schemes land here in a later
 * phase; the registry exists now so nothing above it is written against the
 * local filesystem directly.
 */
export function createAdapter(uri: string): VfsAdapter {
  const { scheme, location } = parseUri(uri)
  switch (scheme) {
    case 'local':
      return new WatchableAdapter(new LocalAdapter(location))
    case 'sftp':
    case 'ftp':
    case 'onedrive':
      throw new Error(`The ${scheme} backend is not available yet`)
    default:
      throw new Error(`Unknown project location: ${uri}`)
  }
}
