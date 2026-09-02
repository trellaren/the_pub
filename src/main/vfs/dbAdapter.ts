import type { VfsAdapter, Unwatch } from './types.js'
import type { VfsEntry, VfsCapabilities, FileChangeEvent } from '../../shared/model/vfs.js'
import type { DbConnection, DbDialect } from './db/dialect.js'
import { DbStore, type DbChangeRow } from './db/store.js'
import { basename, normalizeRelative } from './paths.js'

/**
 * A project that lives in a database.
 *
 * The fourth backend, and the first that is genuinely *better* than a local
 * folder at the two things this app finds hard remotely: a write is a
 * transaction rather than a temp file and a rename with a window in between,
 * and "what changed" is one indexed query rather than a recursive walk every
 * fifteen seconds.
 *
 * No Electron import, following `src/main/onedrive/` — the credentials arrive
 * already decrypted from the registry, and everything here is testable against
 * an in-memory SQLite database.
 */

/** How often to ask for changes when the engine cannot push them. */
export const POLL_INTERVAL_MS = 3000

export interface DbAdapterOptions {
  dialect: DbDialect
  schema: string
  /** For display: what this project is called in a window title. */
  label: string
  /**
   * Create the tables when they are not there.
   *
   * False by default and deliberately so: silently creating tables in someone's
   * production database is not a thing to do quietly, so opening a project on
   * an empty database refuses until the dialog has said what it is about to do
   * and been told to go ahead.
   */
  create?: boolean
  pollIntervalMs?: number
}

export class DbAdapter implements VfsAdapter {
  readonly root: string
  private connection: DbConnection | null = null
  private opened: Promise<DbStore> | null = null
  private readOnly = false

  constructor(private readonly options: DbAdapterOptions) {
    this.root = options.label
  }

  get caps(): VfsCapabilities {
    return {
      // Only Postgres can push. MySQL and SQLite fall back to polling
      // `pub_changes`, which is one indexed query rather than the full
      // recursive walk the other remote backends have to do.
      watch: this.options.dialect.engine === 'postgres',
      atomicRename: true,
      preservesMtime: true,
      fastStat: true,
      caseSensitive: true
    }
  }

  /**
   * Connect, and check what is there.
   *
   * Shared by every call rather than reconnecting: one connection per open
   * project, the way the SFTP adapter holds one session.
   */
  private open(): Promise<DbStore> {
    if (this.opened) return this.opened
    this.opened = (async () => {
      const connection = await this.options.dialect.connect()
      this.connection = connection
      const store = new DbStore(this.options.dialect, connection, this.options.schema)

      const { exists, tooNew } = await store.inspect()
      if (!exists) {
        if (!this.options.create) {
          throw new Error(
            `There is no project in this database yet. Create one from the connection dialog first.`
          )
        }
        await store.create()
      } else if (tooNew) {
        // Same rule as every file kind: a database written by a newer build is
        // read from but never written to, rather than being "upgraded" by a
        // build that does not know what it is looking at.
        this.readOnly = true
      }

      return store
    })()
    return this.opened
  }

  private async writable(): Promise<DbStore> {
    const store = await this.open()
    if (this.readOnly) {
      throw new Error('This project was written by a newer version of Quoth, so it is read-only.')
    }
    return store
  }

  async list(dir: string): Promise<VfsEntry[]> {
    const store = await this.open()
    return (await store.children(normalizeRelative(dir), false)).map(toEntry)
  }

  async stat(target: string): Promise<VfsEntry | null> {
    const store = await this.open()
    const row = await store.get(normalizeRelative(target))
    return row ? toEntry(row) : null
  }

  async readFile(target: string): Promise<Buffer> {
    const store = await this.open()
    const bytes = await store.read(normalizeRelative(target))
    if (!bytes) throw new Error(`No such file: ${target}`)
    return Buffer.from(bytes)
  }

  async writeFile(target: string, data: Buffer): Promise<void> {
    const store = await this.writable()
    const path = normalizeRelative(target)
    await store.transaction(async () => {
      await this.ensureParents(store, path)
      await store.put({ path, kind: 'file', content: new Uint8Array(data) })
    })
  }

  /**
   * The reason a database is a good backend for this.
   *
   * Everywhere else this is a temporary file and a rename, with a window in
   * which a crash leaves both or neither. Here it is one statement in one
   * transaction, and there is no window.
   */
  writeFileAtomic(target: string, data: Buffer): Promise<void> {
    return this.writeFile(target, data)
  }

  async mkdir(target: string): Promise<void> {
    const store = await this.writable()
    const path = normalizeRelative(target)
    if (path === '') return
    await store.transaction(async () => {
      await this.ensureParents(store, path)
      const existing = await store.get(path)
      if (existing?.kind === 'file') throw new Error(`A file already exists at ${target}`)
      if (!existing) await store.put({ path, kind: 'dir', content: null })
    })
  }

  async rename(from: string, to: string): Promise<void> {
    const store = await this.writable()
    const source = normalizeRelative(from)
    const target = normalizeRelative(to)
    if (source === target) return

    await store.transaction(async () => {
      const row = await store.get(source)
      if (!row) throw new Error(`No such file: ${from}`)
      await this.ensureParents(store, target)

      // A directory takes its whole subtree with it. Read before anything moves,
      // because the rows are about to change underneath the query.
      const moving =
        row.kind === 'dir'
          ? [row, ...(await store.children(source, true))]
          : [row]

      for (const entry of moving) {
        const rest = entry.path.slice(source.length)
        const destination = `${target}${rest}`
        const content = entry.kind === 'file' ? await store.read(entry.path) : null
        await store.put({ path: destination, kind: entry.kind, content, mtime: entry.mtime })
      }
      await store.remove(source, true)
    })
  }

  async delete(target: string, options: { recursive?: boolean } = {}): Promise<void> {
    const store = await this.writable()
    const path = normalizeRelative(target)
    if (path === '') throw new Error('The project root cannot be deleted')

    const row = await store.get(path)
    if (!row) return
    if (row.kind === 'dir' && !options.recursive) {
      const children = await store.children(path, false)
      if (children.length > 0) throw new Error(`${target} is not empty`)
    }
    await store.remove(path, true)
  }

  async walk(dir: string, ignoredDirs: string[]): Promise<VfsEntry[]> {
    const store = await this.open()
    const prefix = normalizeRelative(dir)
    const ignored = new Set(ignoredDirs)
    return (await store.children(prefix, true))
      .filter((row) => row.kind === 'file')
      .filter((row) => !row.path.split('/').some((segment) => ignored.has(segment)))
      .map(toEntry)
  }

  /**
   * Follow the change feed.
   *
   * `rev` replaces the recursive diff every other remote backend performs:
   * "what happened since I last looked" is a single indexed query, and Postgres
   * answers it the moment it happens instead of on the next tick.
   *
   * A watcher that has fallen out of the pruning window is told so and reports
   * the whole tree as added, which is what its first tick does anyway.
   */
  async watch(dir: string, onChange: (events: FileChangeEvent[]) => void): Promise<Unwatch> {
    const store = await this.open()
    const prefix = normalizeRelative(dir)
    let cursor = await store.head()
    let stopped = false

    const drain = async (): Promise<void> => {
      if (stopped) return
      const { changes, head, stale } = await store.changesSince(cursor)
      cursor = head
      if (stale) {
        const everything = await store.children(prefix, true)
        onChange(
          everything.map((row) => ({
            type: row.kind === 'dir' ? ('addDir' as const) : ('add' as const),
            path: row.path,
            mtime: row.mtime
          }))
        )
        return
      }
      const relevant = changes.filter((change) => inside(change.path, prefix))
      if (relevant.length > 0) onChange(relevant.map(toChangeEvent))
    }

    const unlisten = await this.connection?.listen?.(() => void drain().catch(() => {}))
    const timer = unlisten
      ? null
      : setInterval(() => void drain().catch(() => {}), this.options.pollIntervalMs ?? POLL_INTERVAL_MS)

    return async () => {
      stopped = true
      if (timer) clearInterval(timer)
      if (unlisten) await unlisten()
    }
  }

  /**
   * Make sure every directory above `path` is a row.
   *
   * Directories are rows rather than inferred from path prefixes, which is
   * tidier right up until an author makes an empty folder — it would then
   * vanish on reopen, having never existed as anything but a prefix of nothing.
   */
  private async ensureParents(store: DbStore, path: string): Promise<void> {
    const segments = path.split('/').slice(0, -1)
    let walked = ''
    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : segment
      const existing = await store.get(walked)
      if (!existing) await store.put({ path: walked, kind: 'dir', content: null })
    }
  }

  async dispose(): Promise<void> {
    await this.connection?.close()
    this.connection = null
    this.opened = null
  }
}

function toEntry(row: { path: string; kind: 'file' | 'dir'; size: number; mtime: number }): VfsEntry {
  return {
    name: basename(row.path),
    path: row.path,
    kind: row.kind,
    size: row.size,
    mtime: row.mtime
  }
}

function toChangeEvent(change: DbChangeRow): FileChangeEvent {
  return { type: change.type, path: change.path }
}

function inside(path: string, prefix: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`)
}
