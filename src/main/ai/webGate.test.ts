import { describe, it, expect } from 'vitest'
import { buildWebGate, extractUrls, fetchPublic, isPublicHttpUrl, resolvesPublic } from './webGate.js'

describe('isPublicHttpUrl', () => {
  it('accepts ordinary public pages', () => {
    expect(isPublicHttpUrl('https://example.org/article?x=1')).toBe(true)
    expect(isPublicHttpUrl('http://93.184.216.34/')).toBe(true)
  })

  it('refuses everything that is not the public web', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.org/x',
      'http://localhost:1234/',
      'http://router.local/',
      'http://intranet/',
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://172.20.1.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.100.0.1/',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fd00::1]/',
      'http://user:pass@example.org/',
      'not a url'
    ]) {
      expect(isPublicHttpUrl(url), url).toBe(false)
    }
  })
})

describe('buildWebGate', () => {
  it('under none allows nothing and offers no search', () => {
    const gate = buildWebGate('none', ['https://example.org/a'])
    expect(gate.canSearch).toBe(false)
    expect(gate.allows('https://example.org/a')).toBe(false)
  })

  it('under urls allows only the pages the writer named, ignoring fragments and trailing slashes', () => {
    const gate = buildWebGate('urls', ['https://example.org/a/', 'https://example.org/b#top'])
    expect(gate.canSearch).toBe(false)
    expect(gate.allows('https://example.org/a')).toBe(true)
    expect(gate.allows('https://example.org/b#section')).toBe(true)
    expect(gate.allows('https://example.org/c')).toBe(false)
    expect(gate.allows('http://10.0.0.1/')).toBe(false)
  })

  it('under search allows any public page, and still no private one', () => {
    const gate = buildWebGate('search')
    expect(gate.canSearch).toBe(true)
    expect(gate.allows('https://anywhere.example/')).toBe(true)
    expect(gate.allows('http://192.168.0.1/')).toBe(false)
  })
})

describe('extractUrls', () => {
  it('finds the links a writer typed, without the punctuation after them', () => {
    expect(extractUrls('Read https://example.org/a, then (https://example.org/b).')).toEqual([
      'https://example.org/a',
      'https://example.org/b'
    ])
    expect(extractUrls('nothing here')).toEqual([])
  })
})

describe('resolvesPublic', () => {
  it('refuses a public-looking name that resolves to a private address', async () => {
    const lookup = async () => [{ address: '127.0.0.1' }]
    expect(await resolvesPublic('https://127.0.0.1.nip.io/', lookup)).toBe(false)
  })

  it('accepts a name that resolves only to public addresses', async () => {
    const lookup = async () => [{ address: '93.184.216.34' }]
    expect(await resolvesPublic('https://example.org/', lookup)).toBe(true)
  })

  it('refuses v4-compatible IPv6 literals', () => {
    expect(isPublicHttpUrl('http://[::7f00:1]/')).toBe(false)
  })
})

describe('fetchPublic', () => {
  const lookup = async () => [{ address: '93.184.216.34' }]

  it('refuses a redirect to a private address', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })) as typeof fetch
    await expect(fetchPublic('https://example.org/', {}, lookup, fetchImpl)).rejects.toThrow(/non-public/)
  })

  it('follows a redirect to another public page', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(url)
      return url.endsWith('/a')
        ? new Response(null, { status: 301, headers: { location: '/b' } })
        : new Response('ok', { status: 200 })
    }) as typeof fetch
    const response = await fetchPublic('https://example.org/a', {}, lookup, fetchImpl)
    expect(await response.text()).toBe('ok')
    expect(seen).toEqual(['https://example.org/a', 'https://example.org/b'])
  })
})
