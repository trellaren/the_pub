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

    this.connecting = new Promise<SFTPWrapper>((resolve, reject) => {
      const client = new Client()
      client
        .on('ready', () => {
          client.sftp((error, sftp) => {
            if (error) {
              reject(error)
              return
            }
            this.client = client
            this.sftp = sftp
            resolve(sftp)
          })
        })
        .on('error', reject)
        .on('close', () => {
          // Drop the handles so the next call reconnects rather than writing
          // into a dead channel.
          this.sftp = null
          this.client = null
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

  private remote(path: string): string {
    const base = trim(this.connection.remotePath)
    const joined = path ? joinRelative(base, path) : base
    return `/${joined}`
  }

  protected async listRaw(dir: string): Promise<VfsEntry[]> {
    const sftp = await this.connected()
    const listing = await promisify<FileEntryWithStats[]>((done) => sftp.readdir(this.remote(dir), done))
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
    const sftp = await this.connected()
    try {
      const stats = await promisify<{ isDirectory: () => boolean; size: number; mtime: number }>((done) =>
        sftp.stat(this.remote(path), done)
      )
      const name = path.slice(path.lastIndexOf('/') + 1)
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      return this.entry(parent, name, stats.isDirectory(), stats.size, stats.mtime * 1000)
    } catch {
      return null
    }
  }

  protected async readRaw(path: string): Promise<Buffer> {
    const sftp = await this.connected()
    return promisify<Buffer>((done) => sftp.readFile(this.remote(path), done))
  }

  protected async writeRaw(path: string, data: Buffer): Promise<void> {
    const sftp = await this.connected()
    await promisify<void>((done) => sftp.writeFile(this.remote(path), data, done))
  }

  protected async mkdirRaw(path: string): Promise<void> {
    const sftp = await this.connected()
    await promisify<void>((done) => sftp.mkdir(this.remote(path), done))
  }

  protected async renameRaw(from: string, to: string): Promise<void> {
    const sftp = await this.connected()
    await promisify<void>((done) => sftp.rename(this.remote(from), this.remote(to), done))
  }

  protected async removeFile(path: string): Promise<void> {
    const sftp = await this.connected()
    await promisify<void>((done) => sftp.unlink(this.remote(path), done))
  }

  protected async removeDir(path: string): Promise<void> {
    const sftp = await this.connected()
    await promisify<void>((done) => sftp.rmdir(this.remote(path), done))
  }

  async dispose(): Promise<void> {
    this.client?.end()
    this.client = null
    this.sftp = null
  }
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
