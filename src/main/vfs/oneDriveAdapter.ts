import { RemoteAdapter } from './remoteAdapter.js'
import type { Unwatch } from './types.js'
import type { VfsEntry, VfsCapabilities, FileChangeEvent } from '../../shared/model/vfs.js'
import { joinRelative, dirnameRelative, basename } from './paths.js'
import {
  GraphClient,
  GraphError,
  itemUrl,
  trimSlashes,
  pathOfItem,
  itemMtime,
  ITEM_FIELDS,
  GRAPH_BASE,
  type DriveItem
} from '../onedrive/graph.js'

/**
 * Small enough to send in one request.
 *
 * Microsoft documents a simple PUT as good for 4 MB; a chapter is a few
 * kilobytes and never comes near it, but an imported map background or a
 * photograph dropped into a manuscript does.
 */
export const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024

/** Upload chunk size. Graph requires a multiple of 320 KiB; this is exactly 16 of them. */
export const UPLOAD_CHUNK = 5 * 1024 * 1024

export const DELTA_POLL_INTERVAL_MS = 15_000

const CAPS: VfsCapabilities = {
  // Delta gives real change detection, so the registry's polling walk — which
  // would be one HTTP request per folder per tick — is not needed here.
  watch: true,
  atomicRename: false,
  // OneDrive preserves the case a name was created with and refuses a second
  // file differing only in case. Unlike the FTP guess, this one is documented.
  caseSensitive: false,
  // An upload stamps the item with the time it arrived, not the time it was
  // written, so mtimes move on their own and cannot be compared across a save.
  preservesMtime: false,
  fastStat: false
}

export interface OneDriveConnection {
  /** Folder inside the drive that becomes the project root. */
  remotePath: string
  /** The signed-in account, for display only. */
  account: string
  client: GraphClient
  /** Overridable so the delta watcher can be driven in a test without waiting. */
  pollIntervalMs?: number
}

interface ItemPage {
  value?: DriveItem[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

/**
 * A project in OneDrive, through the Microsoft Graph API.
 *
 * It is a `RemoteAdapter` like SFTP and FTP, so recursive walks, atomic writes
 * and recursive deletes are the shared implementations and only the eight
 * primitives below are OneDrive's own. Two things genuinely differ: a file over
 * 4 MB has to be uploaded in chunks, and change detection uses Graph's delta
 * feed rather than the registry's polling walk.
 */
export class OneDriveAdapter extends RemoteAdapter {
  readonly caps = CAPS
  readonly root: string
  private readonly client: GraphClient
  private readonly base: string
  private readonly pollIntervalMs: number

  constructor(connection: OneDriveConnection) {
    super()
    this.client = connection.client
    this.base = trimSlashes(connection.remotePath)
    this.pollIntervalMs = connection.pollIntervalMs ?? DELTA_POLL_INTERVAL_MS
    this.root = `onedrive://${connection.account || 'OneDrive'}/${this.base}`
  }

  /** Project-relative path → drive-relative path. */
  private full(path: string): string {
    return this.base ? joinRelative(this.base, path) : path
  }

  protected async listRaw(dir: string): Promise<VfsEntry[]> {
    const entries: VfsEntry[] = []
    // `$top` is a page size, not a limit: Graph pages a large folder and the
    // rest arrives through nextLink. A manuscript folder rarely needs it; a
    // OneDrive root full of photographs does.
    let url: string | undefined = `${itemUrl(this.full(dir), '/children')}?$select=${ITEM_FIELDS}&$top=200`
    while (url) {
      const page: ItemPage = await this.client.json<ItemPage>('GET', url)
      for (const item of page.value ?? []) {
        if (!item.name) continue
        entries.push(this.entry(dir, item.name, Boolean(item.folder), item.size ?? 0, itemMtime(item)))
      }
      url = page['@odata.nextLink']
    }
    return entries
  }

  protected async statRaw(path: string): Promise<VfsEntry | null> {
    try {
      const item = await this.client.json<DriveItem>(
        'GET',
        `${itemUrl(this.full(path))}?$select=${ITEM_FIELDS}`
      )
      return this.entry(
        dirnameRelative(path),
        basename(path) || '',
        Boolean(item.folder),
        item.size ?? 0,
        itemMtime(item)
      )
    } catch (error) {
      // Absence is an answer here, not a failure — `stat` is how every caller
      // asks whether something is there.
      if (error instanceof GraphError && error.notFound) return null
      throw error
    }
  }

  protected async readRaw(path: string): Promise<Buffer> {
    return this.client.bytes(itemUrl(this.full(path), '/content'))
  }

  protected async writeRaw(path: string, data: Buffer): Promise<void> {
    const target = this.full(path)
    if (data.length <= SIMPLE_UPLOAD_LIMIT) {
      await this.client.request('PUT', itemUrl(target, '/content'), {
        body: data,
        headers: { 'content-type': 'application/octet-stream' }
      })
      return
    }
    await this.uploadLarge(target, data)
  }

  /**
   * Upload in chunks through a session.
   *
   * The session URL comes back pre-authenticated and is used without a bearer
   * token. `replace` is the conflict behaviour because this is the same write
   * the simple path performs, and an atomic write has already put the data in a
   * temporary sibling nothing else knows about.
   */
  private async uploadLarge(target: string, data: Buffer): Promise<void> {
    const session = await this.client.json<{ uploadUrl?: string }>(
      'POST',
      itemUrl(target, '/createUploadSession'),
      { item: { '@microsoft.graph.conflictBehavior': 'replace' } }
    )
    const uploadUrl = session.uploadUrl
    if (!uploadUrl) throw new Error('OneDrive did not open an upload session.')

    try {
      for (let offset = 0; offset < data.length; offset += UPLOAD_CHUNK) {
        const chunk = data.subarray(offset, Math.min(offset + UPLOAD_CHUNK, data.length))
        await this.client.request('PUT', uploadUrl, {
          body: chunk,
          anonymous: true,
          headers: {
            'content-length': String(chunk.length),
            'content-range': `bytes ${offset}-${offset + chunk.length - 1}/${data.length}`
          }
        })
      }
    } catch (error) {
      // An abandoned session holds the name for days and blocks the next save,
      // so it is cancelled even though the upload already failed.
      await this.client.request('DELETE', uploadUrl, { anonymous: true }).catch(() => {})
      throw error
    }
  }

  protected async mkdirRaw(path: string): Promise<void> {
    const target = this.full(path)
    await this.client.json('POST', itemUrl(dirnameRelative(target), '/children'), {
      name: basename(target),
      folder: {},
      // The shared `mkdir` already treats an existing folder as success; a
      // rename would silently produce "Chapters 1" and lose the project.
      '@microsoft.graph.conflictBehavior': 'fail'
    })
  }

  protected async renameRaw(from: string, to: string): Promise<void> {
    const target = this.full(to)
    const parent = dirnameRelative(target)
    await this.client.json('PATCH', itemUrl(this.full(from)), {
      name: basename(target),
      // Graph addresses the new parent by path, and the drive root has no path
      // fence — the same asymmetry `itemUrl` handles for URLs.
      parentReference: { path: parent ? `/drive/root:/${parent}` : '/drive/root:' }
    })
  }

  protected async removeFile(path: string): Promise<void> {
    // Graph's DELETE moves the item to the OneDrive recycle bin rather than
    // destroying it, which matches what the local backend does with the Trash.
    await this.client.request('DELETE', itemUrl(this.full(path)))
  }

  protected async removeDir(path: string): Promise<void> {
    await this.removeFile(path)
  }

  /**
   * Change detection through Graph's delta feed.
   *
   * The alternative — the registry's polling watcher — walks the whole project
   * every tick, which is one HTTPS round trip per folder, every fifteen
   * seconds, forever. Delta is one request that returns only what changed, so a
   * laptop on a hotel connection is not spending its battery re-listing a
   * manuscript nobody is editing.
   *
   * Delta runs against the whole drive rather than the project folder, because
   * that is the form Graph documents for path-addressed drives; everything
   * outside the project is filtered out here.
   */
  async watch(dir: string, onChange: (events: FileChangeEvent[]) => void): Promise<Unwatch> {
    const prefix = trimSlashes(this.full(dir))
    let stopped = false
    // `token=latest` asks for a cursor without the enumeration behind it.
    // Priming with a full delta instead would report every existing file as
    // new and re-index the entire project on open.
    let link: string | null = await this.deltaCursor().catch(() => null)

    const tick = async (): Promise<void> => {
      if (stopped || !link) return
      let events: FileChangeEvent[]
      try {
        const result = await this.deltaSince(link, prefix)
        link = result.link
        events = result.events
      } catch {
        return // Transient; the cursor is unchanged, so nothing is missed.
      }
      if (events.length > 0 && !stopped) onChange(events)
    }

    const timer = setInterval(() => void tick(), this.pollIntervalMs)
    return async () => {
      stopped = true
      clearInterval(timer)
    }
  }

  private async deltaCursor(): Promise<string | null> {
    const page = await this.client.json<ItemPage>('GET', `${GRAPH_BASE}/me/drive/root/delta?token=latest`)
    return page['@odata.deltaLink'] ?? null
  }

  private async deltaSince(
    link: string,
    prefix: string
  ): Promise<{ link: string | null; events: FileChangeEvent[] }> {
    const events: FileChangeEvent[] = []
    let url: string | undefined = link
    let next: string | null = null

    while (url) {
      const page: ItemPage = await this.client.json<ItemPage>('GET', url)
      for (const item of page.value ?? []) {
        const event = this.eventFor(item, prefix)
        if (event) events.push(event)
      }
      next = page['@odata.deltaLink'] ?? null
      url = page['@odata.nextLink']
    }
    return { link: next ?? link, events }
  }

  /**
   * One delta item as a change event, or nothing.
   *
   * Existing files are reported as `change` rather than `add` even the first
   * time they are seen: delta does not distinguish the two, and telling them
   * apart would mean keeping a copy of the tree — which is the polling walk
   * this exists to avoid. Both consumers re-read the file either way.
   */
  private eventFor(item: DriveItem, prefix: string): FileChangeEvent | null {
    const drivePath = pathOfItem(item)
    if (!drivePath) return null
    if (prefix && drivePath !== prefix && !drivePath.startsWith(`${prefix}/`)) return null
    const relative = prefix ? drivePath.slice(prefix.length + 1) : drivePath
    if (!relative) return null

    // A deleted item arrives with nothing but its name and the tombstone, so
    // there is no way to know whether it was a file; `unlink` on a folder path
    // matches no open document and no indexed row, and costs nothing.
    if (item.deleted) return { type: 'unlink', path: relative }
    if (item.folder) return null
    return { type: 'change', path: relative, mtime: itemMtime(item) }
  }

  async dispose(): Promise<void> {
    // Nothing is held open: every call is a separate HTTPS request.
  }
}
