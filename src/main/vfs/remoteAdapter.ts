import { ulid } from 'ulid'
import type { VfsAdapter, Unwatch } from './types.js'
import type { VfsEntry, VfsCapabilities, FileChangeEvent } from '../../shared/model/vfs.js'
import { normalizeRelative, joinRelative, dirnameRelative } from './paths.js'

/**
 * Everything a remote backend does that is not protocol-specific.
 *
 * SFTP and FTP differ in about six primitive operations and agree on
 * everything built from them — recursive walks, atomic writes, recursive
 * deletes, path handling. Writing those twice would mean fixing every bug
 * twice, and the versions would drift, so they live here and the protocols
 * implement only what they genuinely differ on.
 */
export abstract class RemoteAdapter implements VfsAdapter {
  abstract readonly caps: VfsCapabilities
  abstract readonly root: string

  /** One directory's children. Paths are project-relative. */
  protected abstract listRaw(dir: string): Promise<VfsEntry[]>
  protected abstract statRaw(path: string): Promise<VfsEntry | null>
  protected abstract readRaw(path: string): Promise<Buffer>
  protected abstract writeRaw(path: string, data: Buffer): Promise<void>
  protected abstract mkdirRaw(path: string): Promise<void>
  protected abstract renameRaw(from: string, to: string): Promise<void>
  protected abstract removeFile(path: string): Promise<void>
  protected abstract removeDir(path: string): Promise<void>
  abstract dispose(): Promise<void>

  async list(dir: string): Promise<VfsEntry[]> {
    return this.listRaw(normalizeRelative(dir))
  }

  async stat(path: string): Promise<VfsEntry | null> {
    return this.statRaw(normalizeRelative(path))
  }

  async readFile(path: string): Promise<Buffer> {
    return this.readRaw(normalizeRelative(path))
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    const target = normalizeRelative(path)
    await this.ensureParent(target)
    await this.writeRaw(target, data)
  }

  /**
   * Write to a temporary neighbour and rename over the target.
   *
   * The same guarantee the local backend gives, and it matters more here: a
   * dropped connection mid-upload leaves a stray temp file rather than a
   * truncated chapter. The temp file is a sibling so the rename stays within
   * one directory, which is the only case a server is obliged to make atomic.
   */
  async writeFileAtomic(path: string, data: Buffer): Promise<void> {
    const target = normalizeRelative(path)
    await this.ensureParent(target)
    const temp = `${target}.tmp-${ulid()}`
    await this.writeRaw(temp, data)
    try {
      await this.replace(temp, target)
    } catch (error) {
      await this.removeFile(temp).catch(() => {})
      throw error
    }
  }

  /**
   * Rename over a destination that may exist.
   *
   * POSIX rename replaces silently; SFTP, FTP and OneDrive all commonly refuse.
   * The fallback therefore moves the existing file aside rather than deleting
   * it, and only removes it once the replacement is in place.
   *
   * Deleting first would be simpler and is what this did originally, but it
   * assumes the rename failed *because* the destination existed. A rename
   * refused for any other reason — no permission, a lock, a throttled account —
   * would then delete the previous version and fail again, and the chapter that
   * was on the server a second ago would be gone. Moving it aside means every
   * failure path still ends with a file at the target.
   */
  private async replace(from: string, to: string): Promise<void> {
    try {
      await this.renameRaw(from, to)
      return
    } catch (error) {
      const existing = await this.statRaw(to).catch(() => null)
      if (!existing) throw error
      await this.replaceExisting(from, to, error)
    }
  }

  private async replaceExisting(from: string, to: string, original: unknown): Promise<void> {
    const aside = `${to}.old-${ulid()}`
    // If even moving it aside fails, nothing has changed yet, so the original
    // failure is still the honest thing to report.
    await this.renameRaw(to, aside).catch(() => {
      throw original
    })

    try {
      await this.renameRaw(from, to)
    } catch (error) {
      let restored = true
      await this.renameRaw(aside, to).catch(() => {
        restored = false
      })
      // The previous version still exists, just not under its own name. Saying
      // where it is turns "my chapter vanished" into something recoverable.
      if (!restored) {
        throw new Error(
          `${describe(error)} The previous version of ${to} is safe, under the name ${aside}.`
        )
      }
      throw error
    }
    // Only now is the previous version genuinely redundant.
    await this.removeFile(aside).catch(() => {})
  }

  async mkdir(path: string): Promise<void> {
    const target = normalizeRelative(path)
    if (!target) return
    // Servers do not create intermediate directories, so walk down making each.
    const segments = target.split('/')
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      const existing = await this.statRaw(current).catch(() => null)
      if (existing?.kind === 'dir') continue
      await this.mkdirRaw(current).catch(async (error: unknown) => {
        // Another writer may have won the race; only a genuine absence is fatal.
        const now = await this.statRaw(current).catch(() => null)
        if (now?.kind !== 'dir') throw error
      })
    }
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = dirnameRelative(path)
    if (parent) await this.mkdir(parent)
  }

  async rename(from: string, to: string): Promise<void> {
    const target = normalizeRelative(to)
    await this.ensureParent(target)
    await this.replace(normalizeRelative(from), target)
  }

  async delete(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = normalizeRelative(path)
    const entry = await this.statRaw(target)
    if (!entry) return
    if (entry.kind !== 'dir') {
      await this.removeFile(target)
      return
    }
    if (options.recursive) {
      for (const child of await this.listRaw(target)) {
        await this.delete(child.path, { recursive: true })
      }
    }
    await this.removeDir(target)
  }

  /**
   * Depth-first listing for the indexer.
   *
   * Sequential rather than parallel on purpose: an SFTP channel and an FTP
   * control connection both serialise anyway, and firing a hundred concurrent
   * listings at a shared host is how an account gets rate-limited.
   */
  async walk(dir: string, ignoredDirs: string[]): Promise<VfsEntry[]> {
    const ignored = new Set(ignoredDirs)
    const found: VfsEntry[] = []
    const queue = [normalizeRelative(dir)]

    while (queue.length > 0) {
      const current = queue.shift()!
      let entries: VfsEntry[]
      try {
        entries = await this.listRaw(current)
      } catch {
        // An unreadable directory must not abort the whole scan.
        continue
      }
      for (const entry of entries) {
        if (entry.kind === 'dir') {
          if (ignored.has(entry.name)) continue
          queue.push(entry.path)
        } else {
          found.push(entry)
        }
      }
    }
    return found
  }

  /**
   * Never called: the registry wraps every adapter whose `caps.watch` is false
   * in the polling watcher. It exists so the interface stays uniform.
   */
  async watch(_dir: string, _onChange: (events: FileChangeEvent[]) => void): Promise<Unwatch> {
    return async () => {}
  }

  protected entry(dir: string, name: string, isDirectory: boolean, size = 0, mtime = 0): VfsEntry {
    return {
      name,
      path: joinRelative(dir, name),
      kind: isDirectory ? 'dir' : 'file',
      size,
      mtime
    }
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /[.!?]$/.test(message) ? message : `${message}.`
}

/**
 * Serialise work onto a connection.
 *
 * An FTP control connection carries exactly one command at a time, and issuing
 * a second mid-transfer corrupts both. Every call goes through here so the
 * caller never has to know that.
 */
export class ConnectionQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    // Swallow rejection on the chain itself, or one failure poisons every
    // later operation queued behind it.
    this.tail = result.catch(() => undefined)
    return result
  }
}
