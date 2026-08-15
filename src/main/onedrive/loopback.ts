import http from 'node:http'
import { AddressInfo } from 'node:net'

/**
 * The loopback listener that catches the OAuth redirect.
 *
 * Microsoft's desktop application platform allows `http://localhost` on any
 * port, which is what lets a desktop app take a redirect without registering a
 * fixed one — and loopback rather than every interface keeps the authorization
 * code on this machine.
 *
 * **It has to listen on both loopback families.** `localhost` resolves to
 * `::1` before `127.0.0.1` on most dual-stack systems, and browsers follow
 * that order, so a listener bound only to `127.0.0.1` never sees the redirect:
 * the sign-in appears to hang until it times out, with nothing to explain it.
 * Binding the IPv4 socket first and then the same port on `::1` means the
 * documented `http://localhost` redirect URI works whichever way it resolves,
 * and an absent IPv6 stack costs nothing.
 */
export interface Loopback {
  port: number
  /** The redirect URL the browser was sent to. */
  redirect: Promise<string>
  /** The families actually bound, for diagnosis and for tests. */
  families: ('ipv4' | 'ipv6')[]
  close: () => Promise<void>
}

export interface LoopbackOptions {
  /** Body served to the browser once the redirect arrives. */
  page: string
  /** How long to wait for the browser before giving up. */
  timeoutMs: number
}

export async function listenOnLoopback(options: LoopbackOptions): Promise<Loopback> {
  let settle: (url: string) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const redirect = new Promise<string>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(options.page)
    if (request.url) settle(request.url)
  }

  const primary = http.createServer(handler)
  await bind(primary, 0, '127.0.0.1')
  const port = (primary.address() as AddressInfo).port

  const servers = [primary]
  const families: ('ipv4' | 'ipv6')[] = ['ipv4']

  // Best effort: a host with no IPv6, or one where something else already holds
  // the port on ::1, still has a working sign-in over IPv4.
  const secondary = http.createServer(handler)
  try {
    await bind(secondary, port, '::1')
    servers.push(secondary)
    families.push('ipv6')
  } catch {
    secondary.close()
  }

  // A browser tab that is never returned to would otherwise hold the port and
  // the pending promise for as long as the app runs.
  const timer = setTimeout(() => fail(new Error('The sign-in was not completed.')), options.timeoutMs)
  timer.unref?.()

  return {
    port,
    redirect,
    families,
    close: async () => {
      clearTimeout(timer)
      await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      )
    }
  }
}

function bind(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}
