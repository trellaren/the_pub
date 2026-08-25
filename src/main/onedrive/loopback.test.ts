import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { listenOnLoopback, type Loopback } from './loopback.js'

let listener: Loopback | null = null

afterEach(async () => {
  await listener?.close()
  listener = null
})

/** A plain GET, so the test does not depend on a fetch implementation's host preference. */
function request(host: string, port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
    })
    let body = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      body += chunk
    })
    socket.on('end', () => resolve(body))
    socket.on('error', reject)
  })
}

/** Whether this machine has an IPv6 loopback at all. Containers often do not. */
function hasIpv6(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, '::1', () => probe.close(() => resolve(true)))
  })
}

describe('listenOnLoopback', () => {
  it('answers on 127.0.0.1', async () => {
    listener = await listenOnLoopback({ page: 'done', failurePage: 'refused', timeoutMs: 5000 })
    const response = await request('127.0.0.1', listener.port, '/callback?code=abc')
    expect(response).toContain('done')
    expect(await listener.redirect).toBe('/callback?code=abc')
  })

  it('answers on ::1 at the same port', async (context) => {
    /*
     * The bug this exists for: `localhost` resolves to `::1` before
     * `127.0.0.1` on most dual-stack systems, and browsers follow that order.
     * A listener bound only to the IPv4 address never sees the redirect, so the
     * sign-in hangs until it times out with nothing to explain it.
     */
    if (!(await hasIpv6())) context.skip('this machine has no IPv6 loopback')

    listener = await listenOnLoopback({ page: 'done', failurePage: 'refused', timeoutMs: 5000 })
    expect(listener.families).toContain('ipv6')
    const response = await request('::1', listener.port, '/callback?code=xyz')
    expect(response).toContain('done')
    expect(await listener.redirect).toBe('/callback?code=xyz')
  })

  it('works on a host with no IPv6 rather than refusing to start', async () => {
    // The IPv6 bind is best effort: an unavailable stack must not stop a
    // sign-in that would work perfectly well over IPv4.
    listener = await listenOnLoopback({ page: 'done', failurePage: 'refused', timeoutMs: 5000 })
    expect(listener.port).toBeGreaterThan(0)
    expect(listener.families).toContain('ipv4')
  })

  it('ignores a request that is not the redirect', async () => {
    /*
     * A browser asks for `/favicon.ico` as well as the page it was sent to.
     * Settling on whichever request arrives first turns a sign-in that worked
     * into "the redirect did not match this attempt", because the favicon
     * carries no state — and the code is spent by then.
     */
    listener = await listenOnLoopback({ page: 'done', failurePage: 'refused', timeoutMs: 5000 })
    const ignored = await request('127.0.0.1', listener.port, '/favicon.ico')
    expect(ignored).not.toContain('done')

    await request('127.0.0.1', listener.port, '/?code=abc&state=st')
    expect(await listener.redirect).toBe('/?code=abc&state=st')
  })

  it('does not tell someone Microsoft refused that they are signed in', async () => {
    listener = await listenOnLoopback({ page: 'done', failurePage: 'refused', timeoutMs: 5000 })
    const response = await request('127.0.0.1', listener.port, '/?error=access_denied&state=st')
    expect(response).toContain('refused')
    expect(response).not.toContain('done')
    // The error still has to reach the app, which is what names the cause.
    expect(await listener.redirect).toContain('error=access_denied')
  })

  it('can be given up on before the timeout', async () => {
    // The dialog's cancel: a sign-in the browser has visibly refused should not
    // hold the app for the remaining five minutes.
    listener = await listenOnLoopback({ page: 'done', failurePage: 'refused', timeoutMs: 300_000 })
    listener.abort('The sign-in was cancelled.')
    await expect(listener.redirect).rejects.toThrow(/cancelled/)
  })

  it('gives up rather than holding the port for the life of the app', async () => {
    listener = await listenOnLoopback({ page: 'done', failurePage: 'refused', timeoutMs: 30 })
    await expect(listener.redirect).rejects.toThrow(/not completed/)
  })

  it('closes every socket it opened', async () => {
    const opened = await listenOnLoopback({ page: 'done', failurePage: 'refused', timeoutMs: 5000 })
    const { port } = opened
    await opened.close()
    // A port still held would make the next sign-in in the same session fail.
    await expect(request('127.0.0.1', port, '/')).rejects.toThrow()
  })
})
