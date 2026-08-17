import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

export interface RendererServer {
  baseUrl: string
  close: () => Promise<void>
  /**
   * Publish an in-memory HTML document under the server's own origin and
   * return its URL. Used by `printService` to give the offscreen print
   * window something to `loadURL` — same-origin, so it shares the CSP a
   * `file://` page could not offer, without writing a temp file to disk.
   * `revoke` removes it; callers call it once the print/PDF pass is done.
   */
  servePrintJob: (html: string) => { url: string; revoke: () => void }
}

/**
 * Serves the packaged renderer over loopback HTTP.
 *
 * A packaged app would normally load its UI from `file://`, but pages with that
 * scheme have an opaque origin: `window.open` cannot share a JS context with
 * them, which is precisely what tearing a pane out into its own window depends
 * on. Serving the same files from `http://127.0.0.1` gives the app a real
 * origin, so popout windows share the opener's stores and editor instances —
 * and it makes the `'self'` content-security-policy meaningful too.
 *
 * The listener is bound to loopback on an OS-assigned port, serves nothing
 * outside the renderer build directory, and sits behind an unguessable path
 * prefix generated per launch.
 */
export async function startRendererServer(rendererDir: string): Promise<RendererServer> {
  const root = path.resolve(rendererDir)
  const token = randomBytes(16).toString('hex')
  const printJobs = new Map<string, string>()

  const server = http.createServer((request, response) => {
    void handle(request, response, root, token, printJobs)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Renderer server did not bind to a port')
  }

  const baseUrl = `http://127.0.0.1:${address.port}/${token}`

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
    servePrintJob: (html: string) => {
      const id = randomBytes(16).toString('hex')
      printJobs.set(id, html)
      return {
        url: `${baseUrl}/print-job/${id}`,
        revoke: () => {
          printJobs.delete(id)
        }
      }
    }
  }
}

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  root: string,
  token: string,
  printJobs: Map<string, string>
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end()
    return
  }

  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  const prefix = `/${token}`
  if (requestUrl.pathname !== prefix && !requestUrl.pathname.startsWith(`${prefix}/`)) {
    response.writeHead(404).end()
    return
  }

  const relative = requestUrl.pathname.slice(prefix.length).replace(/^\/+/, '')

  const printJobMatch = relative.match(/^print-job\/([a-f0-9]+)$/)
  if (printJobMatch) {
    const html = printJobs.get(printJobMatch[1])
    if (html === undefined) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store'
    })
    response.end(request.method === 'HEAD' ? undefined : html)
    return
  }

  const target = path.resolve(root, relative === '' ? 'index.html' : relative)
  // Resolve first, then check containment, so `..` in the URL cannot escape.
  if (target !== root && !target.startsWith(root + path.sep)) {
    response.writeHead(403).end()
    return
  }

  try {
    const stats = await fsp.stat(target)
    if (!stats.isFile()) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'no-store'
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    fs.createReadStream(target).pipe(response)
  } catch {
    response.writeHead(404).end()
  }
}
