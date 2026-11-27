import { GRAPH_BASE, type HttpFetch, type HttpResponse, type DriveItem } from './graph.js'

const DRIVE = `${GRAPH_BASE}/me/drive`
const FIXED_DATE = Date.parse('2026-01-02T03:04:05Z')

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
export class FakeDrive {
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
  /** Requests for a cursor answered with a throttle, to stand in for opening offline. */
  refuseCursor = 0
  /** Delta pages answered with 410 resyncRequired. */
  expireCursor = 0
  /**
   * When each file last changed, for tests that need a second writer's save to
   * be visible as one. Files never written through `fetch` report a fixed date.
   */
  modified = new Map<string, number>()
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
    if (suffix.startsWith('/delta')) return this.deltaPage(query)

    if (init.method === 'GET' && suffix === '/children') return json(this.children(path, query))
    if (init.method === 'GET' && suffix === '/content') return this.content(path)
    if (init.method === 'GET' && !suffix) return this.stat(path)
    if (init.method === 'PUT' && suffix === '/content') return this.put(path, init.body)
    if (init.method === 'POST' && suffix === '/createUploadSession') return this.openSession(path)
    if (init.method === 'POST' && suffix === '/children') return this.create(path, init.body)
    if (init.method === 'PATCH' && !suffix) return this.move(path, init.body, query)
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
    this.modified.set(path, Date.now())
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

  private move(from: string, body: unknown, query: string): HttpResponse {
    const request = JSON.parse(String(body)) as { name: string; parentReference: { path: string } }
    const parent = request.parentReference.path.replace(/^\/drive\/root:\/?/, '')
    const to = parent ? `${parent}/${request.name}` : request.name
    if (this.failMovesTo.has(to)) return error(403, 'accessDenied', 'Access denied')
    const replace = new URLSearchParams(query).get('@microsoft.graph.conflictBehavior') === 'replace'
    if (replace && this.files.has(to) && this.files.has(from)) this.files.delete(to)
    // Real OneDrive refuses a move onto an existing name unless told to
    // replace, which is what the shared move-aside fallback exists for.
    if (this.files.has(to) || this.folders.has(to)) {
      return error(409, 'nameAlreadyExists', 'An item with that name already exists')
    }
    const file = this.files.get(from)
    if (file) {
      this.files.delete(from)
      this.files.set(to, file)
      const changed = this.modified.get(from)
      this.modified.delete(from)
      if (changed !== undefined) this.modified.set(to, changed)
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
    this.modified.set(session.target, Date.now())
    return json({ id })
  }

  private deltaPage(query: string): HttpResponse {
    const params = new URLSearchParams(query)
    // `token=latest` is a cursor with no enumeration behind it.
    if (params.get('token') === 'latest') {
      if (this.refuseCursor > 0) {
        this.refuseCursor -= 1
        return error(400, 'invalidRequest', 'Not now')
      }
      return json({ value: [], '@odata.deltaLink': `${DRIVE}/root/delta?token=${++this.deltaToken}` })
    }
    if (this.expireCursor > 0) {
      this.expireCursor -= 1
      return error(410, 'resyncRequired', 'Resync required')
    }
    const value = this.delta
    this.delta = []
    return json({ value, '@odata.deltaLink': `${DRIVE}/root/delta?token=${++this.deltaToken}` })
  }

  item(path: string): DriveItem {
    const slash = path.lastIndexOf('/')
    const dir = slash === -1 ? '' : path.slice(0, slash)
    const name = slash === -1 ? path : path.slice(slash + 1)
    const file = this.files.get(path)
    return {
      name: name || 'root',
      size: file?.length ?? 0,
      lastModifiedDateTime: new Date(this.modified.get(path) ?? FIXED_DATE).toISOString(),
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
