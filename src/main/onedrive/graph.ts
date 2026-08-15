/**
 * The HTTP half of the OneDrive backend.
 *
 * Everything the adapter does is one authenticated request to Microsoft Graph,
 * and the three things that go wrong are always the same: the token expired,
 * the account is being throttled, or the item is not there. Handling those once
 * here is what lets the adapter read like the SFTP one.
 */

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

/** The subset of `fetch` this module uses, so a test can supply one by hand. */
export interface HttpResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface HttpRequest {
  method: string
  headers: Record<string, string>
  body?: string | Uint8Array
}

export type HttpFetch = (url: string, init: HttpRequest) => Promise<HttpResponse>

/**
 * Where an access token comes from, and how to say it went stale.
 *
 * The client never refreshes anything itself: refreshing means writing a
 * rotated refresh token back to encrypted storage, which is the auth service's
 * job and needs Electron. The client only asks, and says when it was refused.
 */
export interface TokenSource {
  get(): Promise<string>
  invalidate(): void
}

export interface GraphClientOptions {
  tokens: TokenSource
  fetch?: HttpFetch
  sleep?: (ms: number) => Promise<void>
  /** How many times a throttled request is retried before giving up. */
  attempts?: number
}

/** Status codes that mean "later", not "no". */
const RETRYABLE = new Set([429, 503, 504])
/** A `Retry-After` longer than this is honoured as this: an autosave cannot block for two minutes. */
const MAX_BACKOFF_MS = 10_000
const DEFAULT_ATTEMPTS = 4

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message)
    this.name = 'GraphError'
  }

  get notFound(): boolean {
    return this.status === 404 || this.code === 'itemNotFound'
  }
}

export class GraphClient {
  private readonly tokens: TokenSource
  private readonly http: HttpFetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly attempts: number

  constructor(options: GraphClientOptions) {
    this.tokens = options.tokens
    this.http = options.fetch ?? ((url, init) => fetch(url, init as RequestInit))
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.attempts = options.attempts ?? DEFAULT_ATTEMPTS
  }

  /**
   * One authenticated request, retried when the answer was "later".
   *
   * A 401 is retried exactly once and does not count against the throttle
   * budget: it means the token aged out between minting and sending, which is
   * a certainty on a long upload rather than a failure.
   */
  async request(
    method: string,
    url: string,
    options: {
      body?: string | Uint8Array
      headers?: Record<string, string>
      /**
       * Send no `Authorization` header.
       *
       * An upload session URL carries its own credential in the query string,
       * and Microsoft's documentation is explicit that adding a bearer token to
       * it fails the request rather than being ignored.
       */
      anonymous?: boolean
    } = {}
  ): Promise<HttpResponse> {
    let refreshed = false

    for (let attempt = 0; ; attempt++) {
      const auth: Record<string, string> = options.anonymous
        ? {}
        : { authorization: `Bearer ${await this.tokens.get()}` }
      const response = await this.http(url, {
        method,
        headers: { ...auth, ...options.headers },
        ...(options.body === undefined ? {} : { body: options.body })
      })

      if (response.ok) return response

      if (response.status === 401 && !refreshed && !options.anonymous) {
        refreshed = true
        this.tokens.invalidate()
        continue
      }

      if (RETRYABLE.has(response.status) && attempt < this.attempts) {
        await this.sleep(backoffFor(response, attempt))
        continue
      }

      throw await graphError(response)
    }
  }

  async json<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await this.request(method, url, {
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    })
    const text = await response.text()
    return (text ? JSON.parse(text) : {}) as T
  }

  async bytes(url: string): Promise<Buffer> {
    const response = await this.request('GET', url)
    return Buffer.from(await response.arrayBuffer())
  }
}

/**
 * How long to wait before trying again.
 *
 * `Retry-After` is Microsoft telling us exactly how overloaded the account is,
 * so it wins over any guess — but only up to a point, because a save that
 * blocks for two minutes is indistinguishable from a hung app.
 */
export function backoffFor(response: HttpResponse, attempt: number): number {
  const header = response.headers.get('retry-after')
  const seconds = header ? Number(header) : NaN
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS)
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS)
}

async function graphError(response: HttpResponse): Promise<GraphError> {
  const text = await response.text().catch(() => '')
  let code = ''
  let message = ''
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
    code = parsed.error?.code ?? ''
    message = parsed.error?.message ?? ''
  } catch {
    message = text.slice(0, 200)
  }
  return new GraphError(message || `OneDrive refused the request (HTTP ${response.status}).`, response.status, code)
}

/**
 * The Graph URL for an item, given a path relative to the drive root.
 *
 * Graph addresses items by path with a `root:/…:` fence, and the fence is only
 * written when something follows it — `/root:/Novel:` on its own is not a URL
 * Graph accepts. Getting that wrong fails on every call, which is why it is one
 * function rather than a template repeated eight times.
 */
export function itemUrl(path: string, suffix = ''): string {
  const clean = trimSlashes(path)
  if (!clean) return `${GRAPH_BASE}/me/drive/root${suffix}`
  const encoded = clean.split('/').map(encodeURIComponent).join('/')
  return suffix
    ? `${GRAPH_BASE}/me/drive/root:/${encoded}:${suffix}`
    : `${GRAPH_BASE}/me/drive/root:/${encoded}`
}

export function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '')
}

/** What a drive item looks like once the fields we ask for come back. */
export interface DriveItem {
  name?: string
  size?: number
  lastModifiedDateTime?: string
  folder?: { childCount?: number }
  file?: { mimeType?: string }
  deleted?: { state?: string }
  parentReference?: { path?: string; driveId?: string }
}

/** Only these; the default item is large and most of it is never read. */
export const ITEM_FIELDS = 'name,size,lastModifiedDateTime,folder,file,deleted,parentReference'

export function itemMtime(item: DriveItem): number {
  const stamp = item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : NaN
  return Number.isFinite(stamp) ? stamp : 0
}

/**
 * A delta item's path, relative to the drive root.
 *
 * `parentReference.path` arrives as `/drive/root:/Documents/Novel` — or as
 * `/drives/{id}/root:` on a business drive — and the part after `root:` is the
 * only piece that means anything here. Items at the drive root have a parent
 * path ending in `root:` with nothing after it.
 */
export function pathOfItem(item: DriveItem): string | null {
  const parent = item.parentReference?.path
  if (parent === undefined || !item.name) return null
  const marker = parent.indexOf('root:')
  if (marker < 0) return null
  const dir = trimSlashes(decodeURIComponent(parent.slice(marker + 'root:'.length)))
  return dir ? `${dir}/${item.name}` : item.name
}
