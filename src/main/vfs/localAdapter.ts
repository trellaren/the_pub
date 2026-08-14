import fs from 'node:fs/promises'
import path from 'node:path'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { ulid } from 'ulid'
import type { VfsAdapter, Unwatch } from './types.js'
import type { VfsEntry, VfsCapabilities, FileChangeEvent } from '../../shared/model/vfs.js'
import { resolveInRoot, relativeToRoot, joinRelative, normalizeRelative } from './paths.js'
import { IGNORED_DIRS } from '../../shared/constants.js'

const CAPS: VfsCapabilities = {
  watch: true,
  atomicRename: true,
  caseSensitive: process.platform === 'linux',
  preservesMtime: true,
  fastStat: true
}

/** Coalesce watcher bursts (a save touches several files) into one renderer message. */
const WATCH_BATCH_MS = 120

/**
 * Paths the watcher never reports.
 *
 * The directory list is derived from `IGNORED_DIRS` rather than spelled out
 * again, so the walker and the watcher cannot drift apart. That drift was a real
 * bug: `.thepub` was missing here, so `index.db-wal` — rewritten on every single
 * index write — fired a change event and an IPC round trip on every autosave.
 * Nothing depends on `.thepub` watcher events; the file tree filters it out, the
 * document store tracks only `.pubdoc` paths, and the services owning files in
 * there are each their own only writer.
 *
 * The `.tmp-` half is unanchored because `writeFileAtomic` names its temp file
 * `<original>.tmp-<ulid>` — a leading path separator was never going to match it.
 */
const IGNORED_PATH = new RegExp(
  `\\.tmp-|(^|[/\\\\])(${IGNORED_DIRS.map(escapeForRegExp).join('|')})([/\\\\]|$)`
)

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class LocalAdapter implements VfsAdapter {
  readonly caps = CAPS
  readonly root: string
  private watchers = new Set<FSWatcher>()

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  async list(dir: string): Promise<VfsEntry[]> {
    const absolute = resolveInRoot(this.root, dir)
    const dirents = await fs.readdir(absolute, { withFileTypes: true })
    const entries: VfsEntry[] = []
    for (const dirent of dirents) {
      if (!dirent.isFile() && !dirent.isDirectory()) continue
      const relative = joinRelative(dir, dirent.name)
      let size: number | undefined
      let mtime: number | undefined
      try {
        const stats = await fs.stat(path.join(absolute, dirent.name))
        size = stats.size
        mtime = stats.mtimeMs
      } catch {
        // Vanished between readdir and stat — skip rather than fail the listing.
        continue
      }
      entries.push({
        name: dirent.name,
        path: relative,
        kind: dirent.isDirectory() ? 'dir' : 'file',
        size,
        mtime
      })
    }
    return entries.sort(
      (a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1)
    )
  }

  async stat(target: string): Promise<VfsEntry | null> {
    const absolute = resolveInRoot(this.root, target)
    try {
      const stats = await fs.stat(absolute)
      const normalized = normalizeRelative(target)
      return {
        name: path.basename(absolute),
        path: normalized,
        kind: stats.isDirectory() ? 'dir' : 'file',
        size: stats.size,
        mtime: stats.mtimeMs
      }
    } catch {
      return null
    }
  }

  async readFile(target: string): Promise<Buffer> {
    return fs.readFile(resolveInRoot(this.root, target))
  }

  async writeFile(target: string, data: Buffer): Promise<void> {
    const absolute = resolveInRoot(this.root, target)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, data)
  }

  async writeFileAtomic(target: string, data: Buffer): Promise<void> {
    const absolute = resolveInRoot(this.root, target)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    const temp = `${absolute}.tmp-${ulid()}`
    try {
      await fs.writeFile(temp, data)
      await fs.rename(temp, absolute)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  async mkdir(target: string): Promise<void> {
    await fs.mkdir(resolveInRoot(this.root, target), { recursive: true })
  }

  async rename(from: string, to: string): Promise<void> {
    const absoluteTo = resolveInRoot(this.root, to)
    await fs.mkdir(path.dirname(absoluteTo), { recursive: true })
    await fs.rename(resolveInRoot(this.root, from), absoluteTo)
  }

  async delete(target: string, options: { recursive?: boolean } = {}): Promise<void> {
    await fs.rm(resolveInRoot(this.root, target), {
      recursive: options.recursive ?? false,
      force: true
    })
  }

  async walk(dir: string, ignoredDirs: string[]): Promise<VfsEntry[]> {
    const ignored = new Set(ignoredDirs)
    const files: VfsEntry[] = []
    const queue = [normalizeRelative(dir)]
    while (queue.length > 0) {
      const current = queue.shift()!
      let entries: VfsEntry[]
      try {
        entries = await this.list(current)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.kind === 'dir') {
          if (ignored.has(entry.name)) continue
          queue.push(entry.path)
        } else {
          files.push(entry)
        }
      }
    }
    return files
  }

  async watch(dir: string, onChange: (events: FileChangeEvent[]) => void): Promise<Unwatch> {
    const absolute = resolveInRoot(this.root, dir)
    let pending: FileChangeEvent[] = []
    let timer: NodeJS.Timeout | null = null

    const flush = (): void => {
      timer = null
      if (pending.length === 0) return
      const batch = pending
      pending = []
      onChange(batch)
    }

    const push = (type: FileChangeEvent['type']) => (absolutePath: string): void => {
      pending.push({ type, path: relativeToRoot(this.root, absolutePath) })
      if (!timer) timer = setTimeout(flush, WATCH_BATCH_MS)
    }

    const watcher = chokidarWatch(absolute, {
      ignoreInitial: true,
      // Atomic saves land as write-temp + rename; without a settle window the
      // renderer sees the temp file appear and vanish on every keystroke-batch.
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignored: (candidate: string) => IGNORED_PATH.test(candidate)
    })

    watcher
      .on('add', push('add'))
      .on('change', push('change'))
      .on('unlink', push('unlink'))
      .on('addDir', push('addDir'))
      .on('unlinkDir', push('unlinkDir'))

    this.watchers.add(watcher)
    return async () => {
      this.watchers.delete(watcher)
      if (timer) clearTimeout(timer)
      await watcher.close()
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.watchers].map((watcher) => watcher.close()))
    this.watchers.clear()
  }
}
