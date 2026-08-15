import { fileURLToPath } from 'node:url'
import type { VfsAdapter, Unwatch } from './types.js'
import type { FileChangeEvent } from '../../shared/model/vfs.js'
import { LocalAdapter } from './localAdapter.js'
import { SftpAdapter } from './sftpAdapter.js'
import { FtpAdapter } from './ftpAdapter.js'
import { OneDriveAdapter } from './oneDriveAdapter.js'
import { GraphClient, type TokenSource } from '../onedrive/graph.js'
import { pollingWatch } from './pollingWatcher.js'
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
export function createAdapter(uri: string): VfsAdapter {
  const { scheme, location } = parseUri(uri)
  if (scheme === 'local') return new WatchableAdapter(new LocalAdapter(location))
  if (scheme === 'sftp' || scheme === 'ftp' || scheme === 'onedrive') {
    return new WatchableAdapter(createRemote(uri))
  }
  throw new Error(`Unknown project location: ${uri}`)
}

function createRemote(uri: string): VfsAdapter {
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
  const port = profile.port || defaultPort(profile.protocol)

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
    ...(privateKey ? { privateKey, passphrase: secret || undefined } : { password: secret })
  })
}
