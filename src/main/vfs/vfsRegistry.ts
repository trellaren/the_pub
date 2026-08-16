import { fileURLToPath } from 'node:url'
import type { VfsAdapter, Unwatch } from './types.js'
import type { FileChangeEvent } from '../../shared/model/vfs.js'
import { LocalAdapter } from './localAdapter.js'
import { SftpAdapter } from './sftpAdapter.js'
import { FtpAdapter } from './ftpAdapter.js'
import { OneDriveAdapter } from './oneDriveAdapter.js'
import { DbAdapter } from './dbAdapter.js'
import { DbStore } from './db/store.js'
import { sqliteDialect, postgresDialect, mysqlDialect } from './db/dialects.js'
import { GraphClient, type TokenSource } from '../onedrive/graph.js'
import { pollingWatch } from './pollingWatcher.js'
import type { HostKeyPolicy } from './hostKeys.js'
import { parseProjectUri, defaultPort, type ConnectionProfile } from '../../shared/model/connection.js'

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

/**
 * How the registry reaches saved servers.
 *
 * Injected once at startup rather than imported, so this module stays free of
 * Electron and remains unit-testable, and so the connection store is
 * constructed once by the process that owns it.
 */
export interface ConnectionResolver {
  profile: (id: string) => ConnectionProfile | null
  secret: (id: string) => string | null
  privateKey: (profile: ConnectionProfile) => string | null
  /**
   * A source of OneDrive access tokens for a profile.
   *
   * A function rather than a token, because refreshing one means writing a
   * rotated refresh token back to encrypted storage — which needs Electron, and
   * so must not happen in here.
   */
  oneDriveTokens: (profileId: string) => TokenSource
  /** Which SSH host keys this machine has accepted. */
  hostKeys: HostKeyPolicy
}

let resolver: ConnectionResolver | null = null

export function setConnectionResolver(next: ConnectionResolver): void {
  resolver = next
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
 * Build the adapter for a project URI.
 *
 * Remote adapters are wrapped in the same watch emulation as everything else,
 * so the file tree and the indexer keep calling `watch` unconditionally and
 * neither knows the difference.
 */
export interface AdapterOverrides {
  /**
   * Replaces the resolver's host-key policy, for this adapter only.
   *
   * Exists for one caller: `connections:test` wraps the real policy so it can
   * report *which* key was refused and offer it for review. The wrapper defers
   * to the real policy for the verdict, so testing a connection can never
   * accept something opening a project would not.
   */
  hostKeys?: HostKeyPolicy
  /**
   * Let a `db` project create its tables when they are not there.
   *
   * Off unless the caller is the flow that has said, in words, that it is about
   * to create tables in this database — opening a project must never be what
   * quietly writes to someone's production server.
   */
  createDatabase?: boolean
}

export function createAdapter(uri: string, overrides: AdapterOverrides = {}): VfsAdapter {
  const { scheme, location } = parseUri(uri)
  if (scheme === 'local') return new WatchableAdapter(new LocalAdapter(location))
  if (scheme === 'sftp' || scheme === 'ftp' || scheme === 'onedrive' || scheme === 'db') {
    return new WatchableAdapter(createRemote(uri, overrides))
  }
  throw new Error(`Unknown project location: ${uri}`)
}

function createRemote(uri: string, overrides: AdapterOverrides): VfsAdapter {
  const parsed = parseProjectUri(uri)
  if (!parsed) throw new Error(`Unknown project location: ${uri}`)
  if (!resolver) throw new Error('Saved servers are unavailable in this process')

  const profile = resolver.profile(parsed.profileId)
  // The URI names a profile by id, so a server that has been deleted -- or a
  // recents entry from another machine -- fails with something an author can
  // act on rather than a connection timeout.
  if (!profile) throw new Error('That saved server no longer exists on this machine')

  // A path in the URI overrides the profile's own root, so one server can hold
  // several projects.
  const remotePath = parsed.path || profile.remotePath
  const port = profile.port || defaultPort(profile.protocol, profile.engine)

  if (profile.protocol === 'db') {
    return new DbAdapter({
      dialect: dbDialectFor(profile, port, resolver.secret(profile.id) ?? ''),
      // A path in the URI names the schema, the way it names a directory on
      // every other backend: one server, a manuscript per schema.
      schema: parsed.path || profile.schema,
      label: `db://${profile.id}`,
      create: overrides.createDatabase ?? false
    })
  }

  if (profile.protocol === 'onedrive') {
    if (!profile.clientId) {
      throw new Error('This OneDrive server has no Application (client) ID set.')
    }
    return new OneDriveAdapter({
      remotePath,
      account: profile.account,
      client: new GraphClient({ tokens: resolver.oneDriveTokens(profile.id) })
    })
  }

  const secret = resolver.secret(profile.id) ?? ''

  if (profile.protocol === 'ftp') {
    return new FtpAdapter({
      host: profile.host,
      port,
      user: profile.user,
      password: secret,
      secure: profile.secure,
      remotePath
    })
  }

  const privateKey = profile.auth === 'key' ? resolver.privateKey(profile) : null
  if (profile.auth === 'key' && !privateKey) {
    throw new Error(`Could not read the private key at ${profile.privateKeyPath}`)
  }

  return new SftpAdapter({
    host: profile.host,
    port,
    user: profile.user,
    remotePath,
    hostKeys: overrides.hostKeys ?? resolver.hostKeys,
    ...(privateKey ? { privateKey, passphrase: secret || undefined } : { password: secret })
  })
}

/**
 * The dialect for a saved `db` profile.
 *
 * SQLite keeps its file path in `host`, because that is the field that already
 * means "where the thing is"; a second one would be a second thing to keep in
 * step, and they would disagree.
 */
function dbDialectFor(profile: ConnectionProfile, port: number, password: string) {
  const target = {
    host: profile.host,
    port,
    user: profile.user,
    password,
    database: profile.database
  }
  if (profile.engine === 'sqlite') return sqliteDialect(profile.host)
  if (profile.engine === 'mysql') return mysqlDialect(target)
  return postgresDialect(target)
}

/**
 * Look at a `db` profile's database without opening a project on it.
 *
 * Its own entrance rather than a mode of `createAdapter`, because the two
 * questions are different: "can I reach this, and is a project already here"
 * is what the connect dialog asks *before* it offers to create anything.
 */
export async function inspectDatabase(
  profileId: string,
  schemaOverride = ''
): Promise<{ exists: boolean; tooNew: boolean }> {
  const { store, close } = await openDbStore(profileId, schemaOverride)
  try {
    return await store.inspect()
  } finally {
    await close()
  }
}

/**
 * Create the tables for a project.
 *
 * Only ever called from the flow that has told the writer, in words, that it is
 * about to create tables in this database. Nothing else in the app writes DDL.
 */
export async function createDatabaseProject(profileId: string, schemaOverride = ''): Promise<void> {
  const { store, close } = await openDbStore(profileId, schemaOverride)
  try {
    const { exists, tooNew } = await store.inspect()
    if (tooNew) {
      throw new Error('That database holds a project written by a newer version of The Pub.')
    }
    if (!exists) await store.create()
  } finally {
    await close()
  }
}

async function openDbStore(
  profileId: string,
  schemaOverride: string
): Promise<{ store: DbStore; close: () => Promise<void> }> {
  if (!resolver) throw new Error('Saved servers are unavailable in this process')
  const profile = resolver.profile(profileId)
  if (!profile) throw new Error('That saved server no longer exists on this machine')
  if (profile.protocol !== 'db') throw new Error('That server is not a database.')

  const port = profile.port || defaultPort(profile.protocol, profile.engine)
  const dialect = dbDialectFor(profile, port, resolver.secret(profile.id) ?? '')
  const connection = await dialect.connect()
  return {
    store: new DbStore(dialect, connection, schemaOverride || profile.schema),
    close: () => connection.close()
  }
}
