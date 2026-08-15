import { Readable, Writable } from 'node:stream'
import { Client, FileType, type FileInfo } from 'basic-ftp'
import { RemoteAdapter, ConnectionQueue } from './remoteAdapter.js'
import type { VfsEntry, VfsCapabilities } from '../../shared/model/vfs.js'
import { joinRelative } from './paths.js'
import { parseListingDate } from './ftpDates.js'

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

    let listing: FileInfo[]
    try {
      listing = await this.exec((client) => client.list(this.remote(parent)))
    } catch (error) {
      /*
       * Only a genuine absence is "not there".
       *
       * This caught everything once, which meant a listing that failed because
       * the server was unreachable was indistinguishable from a directory that
       * is not there — and `RemoteAdapter.delete` returns silently on a null
       * stat. So deleting a chapter with the connection down reported success,
       * the file tree dropped the row, and the chapter was still on the server.
       * The SFTP backend had the same defect and was corrected in Phase 10;
       * this one waited for a harness of its own to prove it.
       */
      if (isMissing(error)) return null
      throw error
    }

    const match = listing.find((item) => item.name === name)
    if (!match) return null
    if (match.type === FileType.Directory) return this.entry(parent, name, true, match.size, stamp(match))
    return this.entry(parent, name, false, match.size, await this.exactMtime(path, match))
  }

  /**
   * A file's modification time, to the second, via `MDTM`.
   *
   * Worth one extra round trip here and nowhere else. A listing gives a time
   * only to the minute (see `ftpDates.ts`), and this is the reading that
   * `DocumentService` compares to decide whether someone else has edited a
   * chapter since the editor last read it. At minute resolution two edits a few
   * seconds apart look identical, and the guard against overwriting somebody's
   * work quietly stops guarding anything.
   *
   * Directories are excluded because `MDTM` is specified for files, and servers
   * that refuse it for a directory would cost a round trip to learn nothing.
   * The listing's own time is the fallback wherever the server declines.
   */
  private async exactMtime(path: string, listed: FileInfo): Promise<number> {
    try {
      const when = await this.exec((client) => client.lastMod(this.remote(path)))
      return when.getTime()
    } catch {
      return stamp(listed)
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

/**
 * A listed file's modification time.
 *
 * `modifiedAt` is set only when the server speaks MLSD, which most do not — and
 * without this fallback every file in a `LIST` listing reported the epoch. That
 * is not a cosmetic wrong number: the polling watcher detects a change by
 * noticing that an mtime differs from the last poll, so a project where every
 * file claims the same time is one where an edit made anywhere else is never
 * seen, and the search index never catches up with it.
 */
function stamp(item: FileInfo): number {
  if (item.modifiedAt) return item.modifiedAt.getTime()
  return parseListingDate(item.rawModifiedAt)
}

/**
 * Reply codes that mean "the thing you named is not available".
 *
 * 550 is the usual answer for a directory that is not there. 553 and 450 are
 * near neighbours. 451 — "local error in processing" — is in the list because
 * `ftp-srv` answers it for a missing path, and it is a server people really
 * run; a project's first `stat` asks about `.thepub/project.json` before
 * `.thepub` exists, so a backend that treated 451 as a fault could never create
 * a project at all.
 */
const UNAVAILABLE = new Set([450, 451, 550, 553])

/**
 * Whether a failed command means the path is absent, rather than unreachable.
 *
 * The list is of what counts as *absence*, and deliberately so: a reply nobody
 * anticipated then fails loudly instead of being read as "not there", and
 * failing loudly is the safe direction. A `stat` that wrongly reports absence
 * makes `RemoteAdapter.delete` return success without deleting anything, which
 * is how a chapter leaves the file tree while sitting safely on a server nobody
 * can reach; a `stat` that wrongly fails produces an error message.
 *
 * Connection failures carry a string code like `ECONNREFUSED`, or no code at
 * all, so none of them can match — which is the case this exists for.
 *
 * Two known imprecisions, both accepted. Servers answer 550 for a path they
 * will not let you read as well as for one that is not there, so a forbidden
 * path reads as missing. And a genuine transient 451 would too. Both are
 * narrower than the alternative.
 */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'number' && UNAVAILABLE.has(code)
}

function trim(path: string): string {
  return path.replace(/^\/+|\/+$/g, '')
}

/** Codes and messages that mean "the session is gone", not "that failed". */
function isConnectionLost(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /closed|ECONNRESET|EPIPE|ETIMEDOUT|not connected|421/i.test(message)
}
