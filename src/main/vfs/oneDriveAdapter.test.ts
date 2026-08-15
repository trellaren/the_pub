import { describe, it, expect } from 'vitest'
import { OneDriveAdapter, SIMPLE_UPLOAD_LIMIT, UPLOAD_CHUNK } from './oneDriveAdapter.js'
import { GraphClient, GRAPH_BASE, type HttpFetch, type HttpResponse, type DriveItem } from '../onedrive/graph.js'
import type { FileChangeEvent } from '../../shared/model/vfs.js'

const DRIVE = `${GRAPH_BASE}/me/drive`

interface Call {
  method: string
  path: string
  suffix: string
  query: string
  auth: string
  headers: Record<string, string>
}

/**
 * An in-memory OneDrive, answered over the same URL shapes Graph uses.
 *
 * A fake at the HTTP boundary rather than at the adapter's own methods, so the
 * URL building, the fencing and the request bodies are all under test — those
 * are exactly where a backend written against a REST API goes wrong.
 */
class FakeDrive {
  files = new Map<string, Buffer>()
  folders = new Set<string>()
  calls: Call[] = []
  delta: DriveItem[] = []
  deltaToken = 0
  /** Pages a folder listing, so the nextLink path is exercised. */
  pageSize = 200
  failUploadChunks = false
  /** Destinations a move is refused for, by something other than a name clash. */
  failMovesTo = new Set<string>()
  private sessions = new Map<string, { target: string; chunks: Buffer[] }>()

  fetch: HttpFetch = async (url, init) => {
    const [raw, query = ''] = url.split('?')
    const { path, suffix } = parse(raw!)
    this.calls.push({
      method: init.method,
      path,
      suffix,
      query,
      auth: init.headers.authorization ?? '',
      headers: init.headers
    })

    if (raw!.startsWith('https://upload.example/')) return this.upload(raw!, init)
    if (suffix.startsWith('/delta')) return json(this.deltaPage(query))

    if (init.method === 'GET' && suffix === '/children') return json(this.children(path, query))
    if (init.method === 'GET' && suffix === '/content') return this.content(path)
    if (init.method === 'GET' && !suffix) return this.stat(path)
    if (init.method === 'PUT' && suffix === '/content') return this.put(path, init.body)
    if (init.method === 'POST' && suffix === '/createUploadSession') return this.openSession(path)
    if (init.method === 'POST' && suffix === '/children') return this.create(path, init.body)
    if (init.method === 'PATCH' && !suffix) return this.move(path, init.body)
    if (init.method === 'DELETE' && !suffix) return this.remove(path)
    return error(400, 'invalidRequest', `Unhandled ${init.method} ${raw}`)
  }

  private children(path: string, query: string): unknown {
    if (path && !this.folders.has(path)) return { value: [] }
    const prefix = path ? `${path}/` : ''
    const names = new Set<string>()
    for (const key of [...this.files.keys(), ...this.folders]) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (!rest || rest.includes('/')) continue
      names.add(rest)
    }
    const all = [...names].map((name) => this.item(prefix + name))
    const skip = Number(new URLSearchParams(query).get('$skip') ?? 0)
    const page = all.slice(skip, skip + this.pageSize)
    const nextSkip = skip + this.pageSize
    return nextSkip < all.length
      ? { value: page, '@odata.nextLink': `${DRIVE}/root:/${path}:/children?$skip=${nextSkip}` }
      : { value: page }
  }

  private stat(path: string): HttpResponse {
    if (!path || this.folders.has(path) || this.files.has(path)) return json(this.item(path))
    return error(404, 'itemNotFound', 'Item not found')
  }

  private content(path: string): HttpResponse {
    const file = this.files.get(path)
    if (!file) return error(404, 'itemNotFound', 'Item not found')
    return bytes(file)
  }

  private put(path: string, body: unknown): HttpResponse {
    this.files.set(path, Buffer.from(body as Uint8Array))
    return json(this.item(path))
  }

  private create(parent: string, body: unknown): HttpResponse {
    const request = JSON.parse(String(body)) as { name: string; folder?: object }
    const path = parent ? `${parent}/${request.name}` : request.name
    if (this.folders.has(path) || this.files.has(path)) {
      return error(409, 'nameAlreadyExists', 'A folder with that name already exists')
    }
    this.folders.add(path)
    return json(this.item(path))
  }

  private move(from: string, body: unknown): HttpResponse {
    const request = JSON.parse(String(body)) as { name: string; parentReference: { path: string } }
    const parent = request.parentReference.path.replace(/^\/drive\/root:\/?/, '')
    const to = parent ? `${parent}/${request.name}` : request.name
    if (this.failMovesTo.has(to)) return error(403, 'accessDenied', 'Access denied')
    // Real OneDrive refuses a move onto an existing name, which is what the
    // shared delete-then-rename fallback exists for.
    if (this.files.has(to) || this.folders.has(to)) {
      return error(409, 'nameAlreadyExists', 'An item with that name already exists')
    }
    const file = this.files.get(from)
    if (file) {
      this.files.delete(from)
      this.files.set(to, file)
      return json(this.item(to))
    }
    if (!this.folders.has(from)) return error(404, 'itemNotFound', 'Item not found')
    this.folders.delete(from)
    this.folders.add(to)
    return json(this.item(to))
  }

  private remove(path: string): HttpResponse {
    this.files.delete(path)
    this.folders.delete(path)
    return empty(204)
  }

  private openSession(target: string): HttpResponse {
    const id = `s${this.sessions.size}`
    this.sessions.set(id, { target, chunks: [] })
    return json({ uploadUrl: `https://upload.example/${id}?token=preauth` })
  }

  private upload(url: string, init: { method: string; body?: string | Uint8Array }): HttpResponse {
    const id = url.slice('https://upload.example/'.length).split('?')[0]!
    const session = this.sessions.get(id)
    if (!session) return error(404, 'itemNotFound', 'No such session')
    if (init.method === 'DELETE') {
      this.sessions.delete(id)
      return empty(204)
    }
    if (this.failUploadChunks) return error(500, 'generalException', 'Upload failed')
    session.chunks.push(Buffer.from(init.body as Uint8Array))
    const uploaded = Buffer.concat(session.chunks)
    this.files.set(session.target, uploaded)
    return json({ id })
  }

  private deltaPage(query: string): unknown {
    const params = new URLSearchParams(query)
    // `token=latest` is a cursor with no enumeration behind it.
    if (params.get('token') === 'latest') {
      return { value: [], '@odata.deltaLink': `${DRIVE}/root/delta?token=${++this.deltaToken}` }
    }
    const value = this.delta
    this.delta = []
    return { value, '@odata.deltaLink': `${DRIVE}/root/delta?token=${++this.deltaToken}` }
  }

  private item(path: string): DriveItem {
    const slash = path.lastIndexOf('/')
    const dir = slash === -1 ? '' : path.slice(0, slash)
    const name = slash === -1 ? path : path.slice(slash + 1)
    const file = this.files.get(path)
    return {
      name: name || 'root',
      size: file?.length ?? 0,
      lastModifiedDateTime: '2026-01-02T03:04:05Z',
      ...(file ? { file: {} } : { folder: {} }),
      parentReference: { path: dir ? `/drive/root:/${dir}` : '/drive/root:' }
    }
  }
}

/** Undo `itemUrl`: a Graph item URL back into a drive path and a suffix. */
function parse(url: string): { path: string; suffix: string } {
  const rest = url.slice(DRIVE.length)
  if (rest.startsWith('/root:/')) {
    const body = rest.slice('/root:/'.length)
    const fence = body.indexOf(':')
    const encoded = fence === -1 ? body : body.slice(0, fence)
    return {
      path: encoded.split('/').map(decodeURIComponent).join('/'),
      suffix: fence === -1 ? '' : body.slice(fence + 1)
    }
  }
  return { path: '', suffix: rest.slice('/root'.length) }
}

function json(body: unknown): HttpResponse {
  return respond(200, Buffer.from(JSON.stringify(body), 'utf8'))
}
function bytes(buffer: Buffer): HttpResponse {
  return respond(200, buffer)
}
function empty(status: number): HttpResponse {
  return respond(status, Buffer.alloc(0))
}
function error(status: number, code: string, message: string): HttpResponse {
  return respond(status, Buffer.from(JSON.stringify({ error: { code, message } }), 'utf8'))
}
function respond(status: number, body: Buffer): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body.toString('utf8'),
    // `body.buffer` is Node's whole allocation pool, not this buffer — copying
    // the view is the only way to hand back the bytes that were asked for.
    arrayBuffer: async () => new Uint8Array(body).slice().buffer
  }
}

function build(options: { remotePath?: string; pollIntervalMs?: number } = {}): {
  drive: FakeDrive
  adapter: OneDriveAdapter
} {
  const drive = new FakeDrive()
  const adapter = new OneDriveAdapter({
    remotePath: options.remotePath ?? '',
    account: 'writer@example.com',
    pollIntervalMs: options.pollIntervalMs ?? 5,
    client: new GraphClient({
      tokens: { get: async () => 'token-0', invalidate: () => {} },
      fetch: drive.fetch,
      sleep: async () => {}
    })
  })
  return { drive, adapter }
}

describe('OneDriveAdapter', () => {
  it('lists a folder as entries the rest of the app already understands', async () => {
    const { drive, adapter } = build()
    drive.folders.add('Novel')
    drive.files.set('Novel/ch1.pubdoc', Buffer.from('one'))
    drive.folders.add('Novel/notes')

    const entries = await adapter.list('Novel')
    expect(entries).toEqual([
      {
        name: 'ch1.pubdoc',
        path: 'Novel/ch1.pubdoc',
        kind: 'file',
        size: 3,
        mtime: Date.parse('2026-01-02T03:04:05Z')
      },
      { name: 'notes', path: 'Novel/notes', kind: 'dir', size: 0, mtime: Date.parse('2026-01-02T03:04:05Z') }
    ])
  })

  it('follows the pages of a folder too big for one response', async () => {
    // A OneDrive root can hold thousands of items; stopping at the first page
    // would show a truncated file tree and index a truncated project.
    const { drive, adapter } = build()
    drive.pageSize = 2
    for (let index = 0; index < 5; index++) drive.files.set(`ch${index}.pubdoc`, Buffer.from('x'))
    expect(await adapter.list('')).toHaveLength(5)
  })

  it('answers "not there" rather than failing', async () => {
    const { adapter } = build()
    expect(await adapter.stat('missing.pubdoc')).toBeNull()
  })

  it('reads back what it wrote', async () => {
    const { adapter } = build()
    await adapter.writeFile('Novel/ch1.pubdoc', Buffer.from('the lamp had not been lit'))
    expect((await adapter.readFile('Novel/ch1.pubdoc')).toString('utf8')).toBe(
      'the lamp had not been lit'
    )
  })

  it('creates the folders on the way to a new file', async () => {
    const { drive, adapter } = build()
    await adapter.writeFile('a/b/c/ch1.pubdoc', Buffer.from('x'))
    expect(drive.folders.has('a/b/c')).toBe(true)
    // Never a rename-on-conflict: "Chapters 1" beside "Chapters" would split
    // the project in half without an error anywhere.
    const create = drive.calls.find((call) => call.method === 'POST' && call.suffix === '/children')
    expect(create).toBeTruthy()
  })

  it('saves through a temporary sibling, even when the rename is refused', async () => {
    // OneDrive refuses a move onto an existing name, so the shared fallback has
    // to delete first — and a save that lost the file here would lose a chapter.
    const { drive, adapter } = build()
    await adapter.writeFile('ch1.pubdoc', Buffer.from('first draft'))
    await adapter.writeFileAtomic('ch1.pubdoc', Buffer.from('second draft'))

    expect(drive.files.get('ch1.pubdoc')!.toString('utf8')).toBe('second draft')
    expect([...drive.files.keys()]).toEqual(['ch1.pubdoc'])
  })

  it('never destroys the previous draft when a save fails', async () => {
    // OneDrive refuses a write for reasons a manuscript folder really does hit
    // — a retention policy, a file another device has open — and a save that
    // deleted the old version first would take a chapter with it.
    const { drive, adapter } = build()
    drive.files.set('ch1.pubdoc', Buffer.from('first draft'))
    drive.failMovesTo.add('ch1.pubdoc')

    await expect(adapter.writeFileAtomic('ch1.pubdoc', Buffer.from('second draft'))).rejects.toThrow(
      /ch1\.pubdoc\.old-/
    )
    // One file, and it still holds the work: no temporary sibling stranded, and
    // nothing deleted on the way.
    const survivors = [...drive.files.entries()]
    expect(survivors).toHaveLength(1)
    expect(survivors[0]![1].toString('utf8')).toBe('first draft')
  })

  it('deletes a folder and everything under it', async () => {
    const { drive, adapter } = build()
    drive.folders.add('Novel')
    drive.folders.add('Novel/parts')
    drive.files.set('Novel/parts/ch1.pubdoc', Buffer.from('x'))
    await adapter.delete('Novel', { recursive: true })
    expect(drive.files.size).toBe(0)
    expect(drive.folders.size).toBe(0)
  })

  it('walks past the folders the indexer is told to skip', async () => {
    const { drive, adapter } = build()
    drive.files.set('ch1.pubdoc', Buffer.from('x'))
    drive.folders.add('.thepub')
    drive.files.set('.thepub/index.db', Buffer.from('x'))
    const found = await adapter.walk('', ['.thepub'])
    expect(found.map((entry) => entry.path)).toEqual(['ch1.pubdoc'])
  })

  it('keeps the project folder out of every path it hands back', async () => {
    // The project root is a folder inside the drive, and every consumer above
    // works in paths relative to it — a leaked prefix would break every one.
    const { drive, adapter } = build({ remotePath: '/Documents/Novel/' })
    drive.folders.add('Documents/Novel')
    drive.files.set('Documents/Novel/ch1.pubdoc', Buffer.from('x'))

    const entries = await adapter.list('')
    expect(entries[0]!.path).toBe('ch1.pubdoc')
    expect((await adapter.readFile('ch1.pubdoc')).toString('utf8')).toBe('x')
    expect(drive.calls.some((call) => call.path === 'Documents/Novel/ch1.pubdoc')).toBe(true)
  })
})

describe('uploading a file too big for one request', () => {
  it('sends a small file in a single request', async () => {
    const { drive, adapter } = build()
    await adapter.writeFile('ch1.pubdoc', Buffer.alloc(1024, 1))
    expect(drive.calls.some((call) => call.suffix === '/createUploadSession')).toBe(false)
  })

  it('chunks a large one, and each chunk says where it belongs', async () => {
    const { drive, adapter } = build()
    const big = Buffer.alloc(UPLOAD_CHUNK + 1024, 7)
    await adapter.writeFile('map-background.png', big)

    expect(drive.files.get('map-background.png')!.equals(big)).toBe(true)
    const chunks = drive.calls.filter((call) => call.headers['content-range'])
    expect(chunks).toHaveLength(Math.ceil(big.length / UPLOAD_CHUNK))
    expect(chunks[0]!.headers['content-range']).toBe(`bytes 0-${UPLOAD_CHUNK - 1}/${big.length}`)
    expect(chunks.at(-1)!.headers['content-range']).toBe(
      `bytes ${UPLOAD_CHUNK}-${big.length - 1}/${big.length}`
    )
  })

  it('sends no bearer token to an upload URL that already carries one', async () => {
    // Microsoft rejects an authorization header on a pre-authenticated session
    // URL rather than ignoring it, so this is a hard requirement, not hygiene.
    const { drive, adapter } = build()
    await adapter.writeFile('big.png', Buffer.alloc(SIMPLE_UPLOAD_LIMIT + 1, 3))
    const chunk = drive.calls.find((call) => call.headers['content-range'])!
    expect(chunk.auth).toBe('')
    expect(drive.calls.find((call) => call.suffix === '/createUploadSession')!.auth).toBe('Bearer token-0')
  })

  it('cancels the session when the upload fails, so the name is not held', async () => {
    const { drive, adapter } = build()
    drive.failUploadChunks = true
    await expect(adapter.writeFile('big.png', Buffer.alloc(SIMPLE_UPLOAD_LIMIT + 1, 3))).rejects.toThrow()
    expect(drive.calls.some((call) => call.method === 'DELETE')).toBe(true)
  })
})

describe('watching through the delta feed', () => {
  async function collect(
    adapter: OneDriveAdapter,
    dir: string
  ): Promise<{ events: FileChangeEvent[]; stop: () => Promise<void> }> {
    const events: FileChangeEvent[] = []
    const stop = await adapter.watch(dir, (batch) => events.push(...batch))
    return { events, stop }
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 40))
  }

  it('starts from now, rather than reporting the whole project as new', async () => {
    // A full delta on open would look like every file having just changed, and
    // re-index the entire manuscript on every launch.
    const { drive, adapter } = build()
    drive.files.set('ch1.pubdoc', Buffer.from('x'))
    const { events, stop } = await collect(adapter, '')
    await settle()
    expect(events).toEqual([])
    expect(drive.calls.some((call) => call.query === 'token=latest')).toBe(true)
    await stop()
  })

  it('reports a file that changed elsewhere', async () => {
    const { drive, adapter } = build()
    const { events, stop } = await collect(adapter, '')
    drive.delta = [
      {
        name: 'ch1.pubdoc',
        file: {},
        lastModifiedDateTime: '2026-02-02T00:00:00Z',
        parentReference: { path: '/drive/root:' }
      }
    ]
    await settle()
    await stop()
    expect(events).toEqual([
      { type: 'change', path: 'ch1.pubdoc', mtime: Date.parse('2026-02-02T00:00:00Z') }
    ])
  })

  it('reports a deletion as a deletion', async () => {
    const { drive, adapter } = build()
    const { events, stop } = await collect(adapter, '')
    drive.delta = [{ name: 'ch1.pubdoc', deleted: { state: 'deleted' }, parentReference: { path: '/drive/root:' } }]
    await settle()
    await stop()
    expect(events).toEqual([{ type: 'unlink', path: 'ch1.pubdoc' }])
  })

  it('ignores the rest of the drive', async () => {
    // Delta covers the whole drive, and a photograph syncing into Pictures is
    // not a manuscript change.
    const { drive, adapter } = build({ remotePath: 'Documents/Novel' })
    const { events, stop } = await collect(adapter, '')
    drive.delta = [
      { name: 'holiday.jpg', file: {}, parentReference: { path: '/drive/root:/Pictures' } },
      { name: 'ch1.pubdoc', file: {}, parentReference: { path: '/drive/root:/Documents/Novel' } },
      { name: 'parts', folder: {}, parentReference: { path: '/drive/root:/Documents/Novel' } }
    ]
    await settle()
    await stop()
    expect(events).toEqual([{ type: 'change', path: 'ch1.pubdoc', mtime: 0 }])
  })

  it('stops asking once it is stopped', async () => {
    const { drive, adapter } = build()
    const { stop } = await collect(adapter, '')
    await settle()
    await stop()
    const after = drive.calls.length
    await settle()
    expect(drive.calls).toHaveLength(after)
  })
})
