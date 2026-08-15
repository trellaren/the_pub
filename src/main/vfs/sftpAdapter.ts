import { Client, type SFTPWrapper, type FileEntryWithStats } from 'ssh2'
import { RemoteAdapter } from './remoteAdapter.js'
import type { VfsEntry, VfsCapabilities } from '../../shared/model/vfs.js'
import { joinRelative } from './paths.js'

export interface SftpConnection {
  host: string
  port: number
  user: string
  /** One of the two; a key is preferred where the author has one. */
  password?: string
  privateKey?: string
  passphrase?: string
  remotePath: string
}

/**
 * SFTP's status code for "no such file", which ssh2 puts on the error as
 * `code`. It is the one failure that means a path is genuinely absent rather
 * than unreadable, unreachable or refused.
 */
const NO_SUCH_FILE = 2

const CAPS: VfsCapabilities = {
  watch: false,
  // SFTP rename is atomic where the server implements POSIX rename, and the
  // remote base falls back safely where it does not.
  atomicRename: true,
  caseSensitive: true,
  preservesMtime: true,
  fastStat: false
}

/**
 * A project over SSH.
 *
 * Unlike FTP, one SFTP session multiplexes concurrent requests, so there is no
 * command queue here — the channel handles interleaving, and serialising would
 * only make a large project index slower.
 */
export class SftpAdapter extends RemoteAdapter {
  readonly caps = CAPS
  readonly root: string
  private client: Client | null = null
  private sftp: SFTPWrapper | null = null
  private connecting: Promise<SFTPWrapper> | null = null
  /** Rejects when the current session ends; null when there is no session. */
  private lost: Promise<never> | null = null
  private disposed = false

  constructor(private readonly connection: SftpConnection) {
    super()
    this.root = `sftp://${connection.user}@${connection.host}:${connection.port}/${trim(connection.remotePath)}`
  }

  /**
   * Open the session, or join the attempt already in progress.
   *
   * Without the shared promise, the first burst of parallel calls after a
   * reconnect would each open their own session — and SSH servers count
   * sessions per account.
   */
  private async connected(): Promise<SFTPWrapper> {
    if (this.sftp) return this.sftp
    if (this.connecting) return this.connecting
    if (this.disposed) throw new Error('This connection has been closed')

    this.connecting = new Promise<SFTPWrapper>((resolve, reject) => {
      const client = new Client()
      // Held from construction rather than from `ready`: disposing while the
      // handshake is still running has to be able to close this socket, or a
      // project closed mid-connect leaves a session open on the server with
      // nothing left referencing it.
      this.client = client

      let abandon: (error: Error) => void = () => {}
      const lost = new Promise<never>((_, rejectLost) => {
        abandon = rejectLost
      })
      // Nothing races this until a request is in flight, and a rejected promise
      // nobody has attached to is an unhandled rejection.
      lost.catch(() => {})

      client
        .on('ready', () => {
          client.sftp((error, sftp) => {
            if (error) {
              reject(error)
              return
            }
            this.sftp = sftp
            this.lost = lost
            resolve(sftp)
          })
        })
        .on('error', reject)
        .on('close', () => {
          // Drop the handles so the next call reconnects rather than writing
          // into a dead channel.
          this.sftp = null
          this.lost = null
          if (this.client === client) this.client = null

          const gone = new Error('The connection to the server was lost')
          // ssh2 abandons requests that were in flight when the channel died
          // without ever calling them back, so without this an autosave
          // interrupted by a dropped connection would neither finish nor fail —
          // it would simply wait forever. Rejecting here also covers a server
          // that closes during the handshake without emitting an error, which
          // would otherwise leave `connecting` pending for good. Both are
          // no-ops once this promise has already settled.
          abandon(gone)
          reject(gone)
        })
        .connect({
          host: this.connection.host,
          port: this.connection.port,
          username: this.connection.user,
          ...(this.connection.privateKey
            ? { privateKey: this.connection.privateKey, passphrase: this.connection.passphrase }
            : { password: this.connection.password })
        })
    })

    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  /**
   * One request, on a live session, that fails if the session dies under it.
   *
   * Every operation goes through here rather than calling `connected()`
   * directly, because ssh2 gives an outstanding request no callback at all when
   * the channel closes beneath it.
   */
  private async run<T>(operation: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const sftp = await this.connected()
    const lost = this.lost
    const result = operation(sftp)
    return lost ? Promise.race([result, lost]) : result
  }

  private remote(path: string): string {
    const base = trim(this.connection.remotePath)
    const joined = path ? joinRelative(base, path) : base
    return `/${joined}`
  }

  protected async listRaw(dir: string): Promise<VfsEntry[]> {
    const listing = await this.run((sftp) =>
      promisify<FileEntryWithStats[]>((done) => sftp.readdir(this.remote(dir), done))
    )
    return listing
      .filter((item) => item.filename !== '.' && item.filename !== '..')
      .map((item) =>
        this.entry(
          dir,
          item.filename,
          item.attrs.isDirectory(),
          item.attrs.size,
          // SFTP reports seconds; everything above expects milliseconds.
          item.attrs.mtime * 1000
        )
      )
  }

  protected async statRaw(path: string): Promise<VfsEntry | null> {
    try {
      const stats = await this.run((sftp) =>
        promisify<{ isDirectory: () => boolean; size: number; mtime: number }>((done) =>
          sftp.stat(this.remote(path), done)
        )
      )
      const name = path.slice(path.lastIndexOf('/') + 1)
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      return this.entry(parent, name, stats.isDirectory(), stats.size, stats.mtime * 1000)
    } catch (error) {
      // Only a genuine absence is "not there".
      //
      // This caught everything once, which meant a stat that failed because the
      // server was unreachable was indistinguishable from a file that is not
      // there — and `RemoteAdapter.delete` returns silently on a null stat. So
      // deleting a chapter with the connection down reported success, the tree
      // dropped the row, and the chapter was still sitting on the server.
      if (isMissing(error)) return null
      throw error
    }
  }

  protected async readRaw(path: string): Promise<Buffer> {
    return this.run((sftp) => promisify<Buffer>((done) => sftp.readFile(this.remote(path), done)))
  }

  protected async writeRaw(path: string, data: Buffer): Promise<void> {
    await this.run((sftp) => promisify<void>((done) => sftp.writeFile(this.remote(path), data, done)))
  }

  protected async mkdirRaw(path: string): Promise<void> {
    await this.run((sftp) => promisify<void>((done) => sftp.mkdir(this.remote(path), done)))
  }

  protected async renameRaw(from: string, to: string): Promise<void> {
    await this.run((sftp) => promisify<void>((done) => sftp.rename(this.remote(from), this.remote(to), done)))
  }

  protected async removeFile(path: string): Promise<void> {
    await this.run((sftp) => promisify<void>((done) => sftp.unlink(this.remote(path), done)))
  }

  protected async removeDir(path: string): Promise<void> {
    await this.run((sftp) => promisify<void>((done) => sftp.rmdir(this.remote(path), done)))
  }

  /**
   * Close the session, and wait until it really is closed.
   *
   * The wait matters because this is called when a project closes and when a
   * connection test finishes: returning early left the socket open a while
   * longer, and a test that ran while the handshake was still in progress
   * leaked the session entirely.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const client = this.client
    this.client = null
    this.sftp = null
    this.lost = null
    if (!client) return
    await new Promise<void>((resolve) => {
      client.once('close', () => resolve())
      client.end()
    })
  }
}

/** Whether a failed operation means the path is absent, rather than unreachable. */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code
  return code === NO_SUCH_FILE || code === 'ENOENT'
}

/** ssh2 is callback-based throughout; this is the only adaptation it needs. */
function promisify<T>(run: (done: (error: Error | null | undefined, result: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    run((error, result) => (error ? reject(error) : resolve(result)))
  })
}

function trim(path: string): string {
  return path.replace(/^\/+|\/+$/g, '')
}
