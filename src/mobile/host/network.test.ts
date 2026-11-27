import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MobileFs, MemoryBlobStore } from './mobileFs.js'
import type { HostToPage, HttpRequest } from '../protocol.js'

/** What went out as an ordinary fetch, and what was handed to the native shell instead. */
let web: { url: string; init?: RequestInit }[]
let native: HttpRequest[]
let webAnswer: () => Promise<Response>

async function load(isNative: boolean): Promise<typeof import('./network.js')> {
  web = []
  native = []
  webAnswer = async () => new Response('from the web')
  vi.resetModules()
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    web.push({ url, init })
    return webAnswer()
  })
  const fs = await MobileFs.open(new MemoryBlobStore(), { persistent: [], eager: () => true })
  const runtime = await import('./runtime.js')
  runtime.installRuntime({
    fs,
    init: { native: isNative, locale: 'en', version: '0', redirectUri: 'quoth://auth' },
    storageKey: new Uint8Array(32),
    post: (message: HostToPage) => {
      if (message.type !== 'shell' || message.request.op !== 'http') return
      native.push(message.request.request)
      runtime.settleShell(message.id, {
        ok: true,
        value: { status: 200, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('from the shell') }
      })
    }
  })
  return import('./network.js')
}

beforeEach(() => vi.unstubAllGlobals())

describe('hostFetch in the native shell', () => {
  it('sends an ordinary request as an ordinary fetch, so a streamed reply still streams', async () => {
    const { hostFetch } = await load(true)
    const response = await hostFetch('https://graph.microsoft.com/v1.0/me', { headers: { authorization: 'Bearer t' } })
    expect(await response.text()).toBe('from the web')
    expect(native).toEqual([])
  })

  it('sends the token endpoint through the shell, which CORS does not apply to', async () => {
    const { hostFetch } = await load(true)
    const response = await hostFetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token'
    })
    expect(await response.text()).toBe('from the shell')
    expect(web).toEqual([])
    expect(native[0]).toEqual({
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token',
      followRedirects: true
    })
  })

  it('sends a request that must see its own redirects through the shell, unfollowed', async () => {
    const { hostFetch } = await load(true)
    await hostFetch('https://example.com/page', { redirect: 'manual' })
    expect(native[0]).toMatchObject({ url: 'https://example.com/page', method: 'GET', followRedirects: false })
  })

  it('retries through the shell what the page was refused', async () => {
    const { hostFetch } = await load(true)
    webAnswer = async () => {
      throw new TypeError('Failed to fetch')
    }
    const response = await hostFetch('https://api.crossref.org/works/10.1000/182')
    expect(await response.text()).toBe('from the shell')
    expect(web).toHaveLength(1)
  })

  it('does not retry a request the caller cancelled', async () => {
    const { hostFetch } = await load(true)
    const controller = new AbortController()
    controller.abort()
    webAnswer = async () => {
      throw new TypeError('aborted')
    }
    await expect(hostFetch('https://example.com/', { signal: controller.signal })).rejects.toThrow()
    expect(native).toEqual([])
  })

  it('retries an upload through the shell with its bytes intact', async () => {
    const { hostFetch } = await load(true)
    webAnswer = async () => {
      throw new TypeError('Failed to fetch')
    }
    await hostFetch('https://graph.microsoft.com/v1.0/me/drive/root:/a.png:/content', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3])
    })
    expect([...(native[0]!.body as Uint8Array)]).toEqual([1, 2, 3])
  })

  it('does not retry a streamed body, which could only be sent once', async () => {
    const { hostFetch } = await load(true)
    webAnswer = async () => {
      throw new TypeError('Failed to fetch')
    }
    await expect(
      hostFetch('https://example.com/upload', { method: 'POST', body: new Blob(['x']) })
    ).rejects.toThrow('Failed to fetch')
    expect(native).toEqual([])
  })

  it('tells Anthropic the request comes from a browser, which it requires before answering one', async () => {
    const { hostFetch } = await load(true)
    await hostFetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': 'k' }, body: '{}' })
    const headers = new Headers(web[0]!.init?.headers)
    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
    expect(headers.get('x-api-key')).toBe('k')
  })
})

describe('hostFetch in a browser tab', () => {
  it('is the page fetch and nothing more, because there is no shell to ask', async () => {
    const { hostFetch } = await load(false)
    await hostFetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', { method: 'POST', body: 'x=1' })
    expect(web).toHaveLength(1)
    expect(native).toEqual([])
  })
})
