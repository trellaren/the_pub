import { Buffer } from 'buffer'

/**
 * The filesystem the iOS host hands to code written against `node:fs`.
 *
 * Desktop services reach app data through synchronous `fs` calls and projects
 * through asynchronous ones. A WebView has neither, only IndexedDB, which is
 * asynchronous throughout — so every entry's metadata is held in memory, file
 * contents are held too wherever a synchronous read can be asked for, and
 * writes go through to the store behind a queue. A synchronous write is
 * therefore visible at once and durable a moment later.
 */

export type NodeKind = 'file' | 'dir'

export interface StoredMeta {
  kind: NodeKind
  mtimeMs: number
  size: number
}

/** Where entries persist. IndexedDB in the app; a map in tests. */
export interface BlobStore {
  entries(): Promise<[string, StoredMeta][]>
  read(path: string): Promise<Uint8Array | null>
  put(path: string, meta: StoredMeta, data: Uint8Array | null): Promise<void>
  move(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

export interface MobileFsOptions {
  /** Roots whose entries survive a restart. Anything else lives in memory only. */
  persistent: string[]
  /** Persistent files small enough to keep in memory, which is what makes them readable synchronously. */
  eager: (path: string) => boolean
}

export type FsChange = { kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'; path: string }

interface Node extends StoredMeta {
  data?: Uint8Array
}

export class FsError extends Error {
  constructor(
    readonly code: string,
    path: string
  ) {
    super(`${code}: ${DESCRIPTIONS[code] ?? 'file system error'}, '${path}'`)
    this.name = 'Error'
  }
}

const DESCRIPTIONS: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EEXIST: 'file already exists',
  ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory',
  ENOTEMPTY: 'directory not empty'
}

export class Stats {
  constructor(private readonly node: StoredMeta) {}
  get size(): number {
    return this.node.size
  }
  get mtimeMs(): number {
    return this.node.mtimeMs
  }
  get mtime(): Date {
    return new Date(this.node.mtimeMs)
  }
  isFile(): boolean {
    return this.node.kind === 'file'
  }
  isDirectory(): boolean {
    return this.node.kind === 'dir'
  }
  isSymbolicLink(): boolean {
    return false
  }
}

export class Dirent {
  constructor(
    readonly name: string,
    private readonly kind: NodeKind
  ) {}
  isFile(): boolean {
    return this.kind === 'file'
  }
  isDirectory(): boolean {
    return this.kind === 'dir'
  }
  isSymbolicLink(): boolean {
    return false
  }
}

export function normalizePath(input: string): string {
  const parts: string[] = []
  for (const segment of input.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `/${parts.join('/')}`
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
}

type Encoding = BufferEncoding | { encoding?: BufferEncoding | null } | null | undefined

function encodingOf(options: Encoding): BufferEncoding | null {
  if (!options) return null
  return typeof options === 'string' ? options : (options.encoding ?? null)
}

function decode(bytes: Uint8Array, options: Encoding): Buffer | string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const encoding = encodingOf(options)
  return encoding ? buffer.toString(encoding) : buffer
}

export class MobileFs {
  private readonly nodes = new Map<string, Node>([['/', { kind: 'dir', mtimeMs: 0, size: 0 }]])
  private readonly listeners = new Set<(change: FsChange) => void>()
  /**
   * Store writes, in the order the calls that caused them were made. Reads of
   * content that is not in memory wait on it, so a read can never overtake the
   * write it follows.
   */
  private queue: Promise<void> = Promise.resolve()
  private failure: unknown = null
  /** Strictly increasing, so two writes in one millisecond still read as a change. */
  private lastStamp = 0

  private constructor(
    private readonly store: BlobStore,
    private readonly options: MobileFsOptions
  ) {}

  static async open(store: BlobStore, options: MobileFsOptions): Promise<MobileFs> {
    const fs = new MobileFs(store, options)
    const entries = await store.entries()
    for (const [path, meta] of entries) fs.nodes.set(path, { ...meta })
    await Promise.all(
      entries
        .filter(([path, meta]) => meta.kind === 'file' && fs.isEager(path))
        .map(async ([path]) => {
          const node = fs.nodes.get(path)
          if (node) node.data = (await store.read(path)) ?? new Uint8Array()
        })
    )
    for (const root of options.persistent) fs.mkdirSync(root, { recursive: true })
    return fs
  }

  /** Resolves once every write made so far has reached the store. */
  async flush(): Promise<void> {
    await this.queue
    if (this.failure) {
      const error = this.failure
      this.failure = null
      throw error
    }
  }

  onChange(listener: (change: FsChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  existsSync(path: string): boolean {
    return this.nodes.has(normalizePath(path))
  }

  statSync(path: string): Stats {
    return new Stats(this.require(normalizePath(path)))
  }

  readdirSync(path: string): string[] {
    return this.children(normalizePath(path)).map(nameOf)
  }

  readFileSync(path: string, options?: Encoding): Buffer | string {
    const target = normalizePath(path)
    const node = this.requireFile(target)
    if (!node.data) {
      throw new Error(`'${target}' is outside the storage this app can read synchronously`)
    }
    return decode(node.data, options)
  }

  writeFileSync(path: string, data: string | Uint8Array, _options?: unknown): void {
    const target = normalizePath(path)
    const parent = this.nodes.get(parentOf(target))
    if (!parent) throw new FsError('ENOENT', target)
    if (parent.kind !== 'dir') throw new FsError('ENOTDIR', target)
    const existing = this.nodes.get(target)
    if (existing?.kind === 'dir') throw new FsError('EISDIR', target)

    const bytes = toBytes(data)
    const node: Node = { kind: 'file', mtimeMs: this.stamp(), size: bytes.byteLength }
    const persistent = this.isPersistent(target)
    if (!persistent || this.isEager(target)) node.data = bytes
    this.nodes.set(target, node)
    if (persistent) this.enqueue(() => this.store.put(target, metaOf(node), bytes))
    this.emit({ kind: existing ? 'change' : 'add', path: target })
  }

  mkdirSync(path: string, options?: { recursive?: boolean }): void {
    const target = normalizePath(path)
    const existing = this.nodes.get(target)
    if (existing) {
      if (existing.kind === 'dir' && options?.recursive) return
      throw new FsError('EEXIST', target)
    }
    const parent = parentOf(target)
    if (!this.nodes.has(parent)) {
      if (!options?.recursive) throw new FsError('ENOENT', target)
      this.mkdirSync(parent, options)
    } else if (this.nodes.get(parent)!.kind !== 'dir') {
      throw new FsError('ENOTDIR', target)
    }
    const node: Node = { kind: 'dir', mtimeMs: this.stamp(), size: 0 }
    this.nodes.set(target, node)
    if (this.isPersistent(target)) this.enqueue(() => this.store.put(target, metaOf(node), null))
    this.emit({ kind: 'addDir', path: target })
  }

  renameSync(from: string, to: string): void {
    const source = normalizePath(from)
    const target = normalizePath(to)
    const node = this.require(source)
    if (source === target) return
    if (!this.nodes.has(parentOf(target))) throw new FsError('ENOENT', target)
    const replaced = this.nodes.get(target)
    if (replaced) {
      if (replaced.kind === 'dir' && this.children(target).length > 0) throw new FsError('ENOTEMPTY', target)
      if (replaced.kind !== node.kind) throw new FsError(replaced.kind === 'dir' ? 'EISDIR' : 'ENOTDIR', target)
    }

    const moving = [source, ...this.descendants(source)]
    for (const path of moving) {
      const destination = target + path.slice(source.length)
      const moved = this.nodes.get(path)!
      this.nodes.delete(path)
      this.nodes.set(destination, moved)
      this.persistMove(path, destination, moved)
      this.emit({ kind: moved.kind === 'dir' ? 'unlinkDir' : 'unlink', path })
      this.emit({
        kind: moved.kind === 'dir' ? 'addDir' : replaced && path === source ? 'change' : 'add',
        path: destination
      })
    }
  }

  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    const target = normalizePath(path)
    const node = this.nodes.get(target)
    if (!node) {
      if (options?.force) return
      throw new FsError('ENOENT', target)
    }
    const inside = this.descendants(target)
    if (node.kind === 'dir' && inside.length > 0 && !options?.recursive) {
      throw new FsError('ENOTEMPTY', target)
    }
    // Deepest first, so a watcher hears of a file going before its folder does.
    for (const each of [...inside.reverse(), target]) {
      const removed = this.nodes.get(each)!
      this.nodes.delete(each)
      if (this.isPersistent(each)) this.enqueue(() => this.store.remove(each))
      this.emit({ kind: removed.kind === 'dir' ? 'unlinkDir' : 'unlink', path: each })
    }
  }

  async readFile(path: string, options?: Encoding): Promise<Buffer | string> {
    const target = normalizePath(path)
    const node = this.requireFile(target)
    if (node.data) return decode(node.data, options)
    await this.flush()
    const bytes = await this.store.read(target)
    if (!bytes) throw new FsError('ENOENT', target)
    return decode(bytes, options)
  }

  async writeFile(path: string, data: string | Uint8Array, options?: unknown): Promise<void> {
    this.writeFileSync(path, data, options)
    await this.flush()
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.mkdirSync(path, options)
    await this.flush()
  }

  async rename(from: string, to: string): Promise<void> {
    this.renameSync(from, to)
    await this.flush()
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    this.rmSync(path, options)
    await this.flush()
  }

  async stat(path: string): Promise<Stats> {
    return this.statSync(path)
  }

  async readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> {
    const target = normalizePath(path)
    const paths = this.children(target)
    return options?.withFileTypes
      ? paths.map((each) => new Dirent(nameOf(each), this.nodes.get(each)!.kind))
      : paths.map(nameOf)
  }

  /** There are no links here, so a path that exists is already its own real path. */
  async realpath(path: string): Promise<string> {
    const target = normalizePath(path)
    this.require(target)
    return target
  }

  private require(path: string): Node {
    const node = this.nodes.get(path)
    if (!node) throw new FsError('ENOENT', path)
    return node
  }

  private requireFile(path: string): Node {
    const node = this.require(path)
    if (node.kind === 'dir') throw new FsError('EISDIR', path)
    return node
  }

  private children(dir: string): string[] {
    const node = this.require(dir)
    if (node.kind !== 'dir') throw new FsError('ENOTDIR', dir)
    const prefix = dir === '/' ? '/' : `${dir}/`
    const found: string[] = []
    for (const path of this.nodes.keys()) {
      if (path !== '/' && path.startsWith(prefix) && !path.includes('/', prefix.length)) found.push(path)
    }
    return found.sort()
  }

  private descendants(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`
    return [...this.nodes.keys()].filter((path) => path !== '/' && path.startsWith(prefix)).sort()
  }

  private persistMove(from: string, to: string, node: Node): void {
    const wasPersistent = this.isPersistent(from)
    const isPersistent = this.isPersistent(to)
    if (wasPersistent && isPersistent) {
      if (!this.isEager(to)) delete node.data
      this.enqueue(() => this.store.move(from, to))
      return
    }
    if (wasPersistent) {
      // Leaving the store for memory: the bytes have to come with it.
      this.enqueue(async () => {
        if (node.kind === 'file' && !node.data) node.data = (await this.store.read(from)) ?? new Uint8Array()
        await this.store.remove(from)
      })
      return
    }
    if (isPersistent) {
      const data = node.kind === 'file' ? (node.data ?? new Uint8Array()) : null
      if (!this.isEager(to)) delete node.data
      this.enqueue(() => this.store.put(to, metaOf(node), data))
    }
  }

  private isPersistent(path: string): boolean {
    return this.options.persistent.some((root) => isUnder(path, root))
  }

  private isEager(path: string): boolean {
    return this.options.eager(path)
  }

  private enqueue(operation: () => Promise<void>): void {
    this.queue = this.queue.then(operation).catch((error) => {
      this.failure ??= error
    })
  }

  private stamp(): number {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1)
    return this.lastStamp
  }

  private emit(change: FsChange): void {
    for (const listener of this.listeners) listener(change)
  }
}

function metaOf(node: Node): StoredMeta {
  return { kind: node.kind, mtimeMs: node.mtimeMs, size: node.size }
}

/** A store that forgets everything on reload: tests, and private windows with no IndexedDB. */
export class MemoryBlobStore implements BlobStore {
  private readonly meta = new Map<string, StoredMeta>()
  private readonly data = new Map<string, Uint8Array>()

  async entries(): Promise<[string, StoredMeta][]> {
    return [...this.meta.entries()]
  }
  async read(path: string): Promise<Uint8Array | null> {
    return this.data.get(path) ?? null
  }
  async put(path: string, meta: StoredMeta, data: Uint8Array | null): Promise<void> {
    this.meta.set(path, meta)
    if (data) this.data.set(path, data)
    else this.data.delete(path)
  }
  async move(from: string, to: string): Promise<void> {
    const meta = this.meta.get(from)
    if (!meta) return
    const data = this.data.get(from)
    this.meta.delete(from)
    this.data.delete(from)
    this.meta.set(to, meta)
    if (data) this.data.set(to, data)
  }
  async remove(path: string): Promise<void> {
    this.meta.delete(path)
    this.data.delete(path)
  }
}

const DB_NAME = 'quoth-files'
const META = 'meta'
const DATA = 'data'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

/**
 * Metadata and contents live in separate object stores so start-up can read
 * every entry's metadata without pulling a project's images through memory.
 */
export class IndexedDbBlobStore implements BlobStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = DB_NAME): Promise<IndexedDbBlobStore> {
    const opening = indexedDB.open(name, 1)
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore(META)
      opening.result.createObjectStore(DATA)
    }
    return new IndexedDbBlobStore(await request(opening))
  }

  async entries(): Promise<[string, StoredMeta][]> {
    const store = this.db.transaction(META, 'readonly').objectStore(META)
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
    return keys.map((key, index) => [String(key), values[index] as StoredMeta])
  }

  async read(path: string): Promise<Uint8Array | null> {
    const store = this.db.transaction(DATA, 'readonly').objectStore(DATA)
    const found = (await request(store.get(path))) as Uint8Array | undefined
    return found ?? null
  }

  async put(path: string, meta: StoredMeta, data: Uint8Array | null): Promise<void> {
    const transaction = this.db.transaction([META, DATA], 'readwrite')
    transaction.objectStore(META).put(meta, path)
    if (data) transaction.objectStore(DATA).put(data, path)
    else transaction.objectStore(DATA).delete(path)
    await settled(transaction)
  }

  async move(from: string, to: string): Promise<void> {
    const transaction = this.db.transaction([META, DATA], 'readwrite')
    const done = settled(transaction)
    const meta = transaction.objectStore(META)
    const data = transaction.objectStore(DATA)
    const metaRequest = meta.get(from)
    metaRequest.onsuccess = () => {
      if (metaRequest.result === undefined) return
      meta.put(metaRequest.result, to)
      meta.delete(from)
      const dataRequest = data.get(from)
      dataRequest.onsuccess = () => {
        if (dataRequest.result === undefined) return
        data.put(dataRequest.result, to)
        data.delete(from)
      }
    }
    await done
  }

  async remove(path: string): Promise<void> {
    const transaction = this.db.transaction([META, DATA], 'readwrite')
    transaction.objectStore(META).delete(path)
    transaction.objectStore(DATA).delete(path)
    await settled(transaction)
  }
}
