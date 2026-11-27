import { current, shell } from './runtime.js'

/**
 * `fetch` for the host, which differs from the page's in one way that matters:
 * the WebView enforces CORS and Electron's main process does not.
 *
 * Most of what the app talks to — Microsoft Graph, the AI providers — answers
 * cross-origin requests, so those go out as ordinary fetches and keep their
 * streaming. What does not is sent through the native shell instead: the
 * Microsoft token endpoint, which refuses cross-origin redemption for this
 * kind of app registration outright, any request that must see a redirect
 * rather than follow it, and anything an ordinary fetch was refused.
 */

const webFetch = globalThis.fetch.bind(globalThis)

const NATIVE_ONLY_HOSTS = new Set(['login.microsoftonline.com'])

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, name) => {
    headers[name] = value
  })
  return headers
}

function textBody(body: BodyInit | null | undefined): string | undefined | null {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  return null
}

async function nativeFetch(url: string, init: RequestInit | undefined, body: string | undefined): Promise<Response> {
  const result = await shell({
    op: 'http',
    request: {
      url,
      method: init?.method ?? 'GET',
      headers: headersOf(init),
      body,
      followRedirects: init?.redirect !== 'manual'
    }
  })
  const empty = result.status === 204 || result.status === 304 || result.body.byteLength === 0
  return new Response(empty ? null : (result.body as BodyInit), { status: result.status, headers: result.headers })
}

export async function hostFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!current().init.native || typeof input !== 'string') return webFetch(input, init)

  const body = textBody(init?.body)
  const sendable = body !== null
  let host = ''
  try {
    host = new URL(input).hostname
  } catch {
    return webFetch(input, init)
  }

  if (sendable && (NATIVE_ONLY_HOSTS.has(host) || init?.redirect === 'manual')) {
    return nativeFetch(input, init, body)
  }
  try {
    return await webFetch(input, withBrowserAccess(host, init))
  } catch (error) {
    // A TypeError is how a page is told "refused" — CORS included — with no
    // more detail than that. An abort is the caller's own doing.
    if (!sendable || !(error instanceof TypeError) || init?.signal?.aborted) throw error
    return nativeFetch(input, init, body)
  }
}

/** Anthropic answers a browser only when the request says it knows it is one. */
function withBrowserAccess(host: string, init: RequestInit | undefined): RequestInit | undefined {
  if (host !== 'api.anthropic.com') return init
  const headers = new Headers(init?.headers)
  headers.set('anthropic-dangerous-direct-browser-access', 'true')
  return { ...init, headers }
}

export function installHostFetch(): void {
  globalThis.fetch = hostFetch as typeof fetch
}
