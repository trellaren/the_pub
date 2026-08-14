import { Readable, Writable } from 'node:stream'
import { Client, FileType, type FileInfo } from 'basic-ftp'
import { RemoteAdapter, ConnectionQueue } from './remoteAdapter.js'
import type { VfsEntry, VfsCapabilities } from '../../shared/model/vfs.js'
import { joinRelative } from './paths.js'

export interface FtpConnection {
  host: string
  port: number
  user: string
  password: string
  secure: boolean
  /** Directory on the server that becomes the project root. */
  remotePath: string
}

const CAPS: VfsCapabilities = {
  // No change notifications exist in the protocol, so the registry polls.
  watch: false,
  atomicRename: false,
  // Servers vary, and the safe assumption is the one that avoids collisions.
  caseSensitive: true,
  preservesMtime: false,
  // Every stat is a round trip, which is why the indexer batches its work.
  fastStat: false
}

/**
 * A project on an FTP server.
 *
 * Everything goes through one control connection and one queue: FTP carries a
 * single command at a time, and issuing a second mid-transfer corrupts both.
 * The connection is opened lazily and re-opened after a drop, because a server
 * will close an idle session out from under a writer who has stepped away for
 * lunch.
 */
export class FtpAdapter extends RemoteAdapter {
  readonly caps = CAPS
  readonly root: string
  private client: Client | null = null
  private readonly queue = new ConnectionQueue()

  constructor(private readonly connection: FtpConnection) {
    super()
    this.root = `ftp://${connection.user}@${connection.host}:${connection.port}/${trim(connection.remotePath)}`
  }

  private async connected(): Promise<Client> {
    if (this.client && !this.client.closed) return this.client
    const client = new Client(30_000)
    await client.access({
      host: this.connection.host,
      port: this.connection.port,
      user: this.connection.user,
      password: this.connection.password,
      secure: this.connection.secure
    })
    this.client = client
    return client
  }

  /** Run one command, reconnecting once if the session has been dropped. */
  private exec<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      try {
        return await operation(await this.connected())
      } catch (error) {
        if (!isConnectionLost(error)) throw error
        this.client?.close()
        this.client = null
        return operation(await this.connected())
      }
    })
  }

  private remote(path: string): string {
    const base = trim(this.connection.remotePath)
    const joined = path ? joinRelative(base, path) : base
    return `/${joined}`
  }

  protected async listRaw(dir: string): Promise<VfsEntry[]> {
    const listing = await this.exec((client) => client.list(this.remote(dir)))
    return listing
      .filter((item) => item.name !== '.' && item.name !== '..')
      .map((item) => this.entry(dir, item.name, item.type === FileType.Directory, item.size, stamp(item)))
  }

  protected async statRaw(path: string): Promise<VfsEntry | null> {
    if (!path) return this.entry('', '', true)
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const name = path.slice(path.lastIndexOf('/') + 1)
    try {
      const listing = await this.exec((client) => client.list(this.remote(parent)))
      const match = listing.find((item) => item.name === name)
      if (!match) return null
      return this.entry(parent, name, match.type === FileType.Directory, match.size, stamp(match))
    } catch {
      return null
    }
  }

  protected async readRaw(path: string): Promise<Buffer> {
    return this.exec(async (client) => {
      const chunks: Buffer[] = []
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk))
          callback()
        }
      })
      await client.downloadTo(sink, this.remote(path))
      return Buffer.concat(chunks)
    })
  }

  protected async writeRaw(path: string, data: Buffer): Promise<void> {
    await this.exec((client) => client.uploadFrom(Readable.from(data), this.remote(path)))
  }

  protected async mkdirRaw(path: string): Promise<void> {
    // `send` rather than ensureDir: ensureDir changes the working directory,
    // which every other queued command would then be relative to.
    await this.exec((client) => client.send(`MKD ${this.remote(path)}`))
  }

  protected async renameRaw(from: string, to: string): Promise<void> {
    await this.exec((client) => client.rename(this.remote(from), this.remote(to)))
  }

  protected async removeFile(path: string): Promise<void> {
    await this.exec((client) => client.remove(this.remote(path)))
  }

  protected async removeDir(path: string): Promise<void> {
    await this.exec((client) => client.send(`RMD ${this.remote(path)}`))
  }

  async dispose(): Promise<void> {
    this.client?.close()
    this.client = null
  }
}

function stamp(item: FileInfo): number {
  return item.modifiedAt ? item.modifiedAt.getTime() : 0
}

function trim(path: string): string {
  return path.replace(/^\/+|\/+$/g, '')
}

/** Codes and messages that mean "the session is gone", not "that failed". */
function isConnectionLost(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /closed|ECONNRESET|EPIPE|ETIMEDOUT|not connected|421/i.test(message)
}
