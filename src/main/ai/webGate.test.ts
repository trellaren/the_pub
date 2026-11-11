import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect } from 'vitest'
import { Agent, fetch as undiciFetch } from 'undici'
import {
  buildWebGate,
  extractUrls,
  fetchPublic,
  isPublicAddress,
  isPublicHttpUrl,
  pinnedLookup,
  resolvesPublic,
  type ResolveAll
} from './webGate.js'

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

describe('the wider private ranges', () => {
  it.each([
    'fe80::1',
    'febf:ffff::1',
    'fe9a::1',
    'fec0::1',
    'feff::1',
    '64:ff9b::7f00:1',
    '64:ff9b::10.0.0.1',
    '::ffff:127.0.0.1',
    '198.18.0.1',
    '198.19.255.254',
    'fc00::1',
    'ff02::1'
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
    expect(isPublicHttpUrl(address.includes(':') ? `http://[${address}]/` : `http://${address}/`)).toBe(false)
  })

  it.each(['2606:4700::1111', '2001:db8::1', '198.20.0.1', '198.17.255.1', '64:ff9c::1'])('accepts %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })
})

function resolvingTo(address: string, family = 4): ResolveAll {
  return (_hostname, _options, callback) => callback(null, [{ address, family }])
}

describe('pinnedLookup', () => {
  it('refuses at connect time a name that resolves to a private address', async () => {
    const lookup = pinnedLookup(() => false, resolvingTo('127.0.0.1'))
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookup('rebind.example', { all: false }, (failure) => resolve(failure))
    )
    expect(error?.code).toBe('ENOTPUBLIC')
  })

  it('hands back a public address in the shape the socket asked for', async () => {
    const lookup = pinnedLookup(() => false, resolvingTo('93.184.216.34'))
    const single = await new Promise<unknown[]>((resolve) =>
      lookup('example.org', { all: false }, (_e, address, family) => resolve([address, family]))
    )
    expect(single).toEqual(['93.184.216.34', 4])
    const all = await new Promise<unknown>((resolve) => lookup('example.org', { all: true }, (_e, address) => resolve(address)))
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('stops a real connection whose name rebinds to loopback after the check', async () => {
    const server = http.createServer((_request, response) => response.end('internal'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const pinned = new Agent({ connect: { lookup: pinnedLookup(() => false, resolvingTo('127.0.0.1')) } })
      await expect(undiciFetch(`http://rebind.example:${port}/`, { dispatcher: pinned })).rejects.toThrow()

      const trusted = new Agent({ connect: { lookup: pinnedLookup(() => true, resolvingTo('127.0.0.1')) } })
      const response = await undiciFetch(`http://fixture.example:${port}/`, { dispatcher: trusted })
      expect(await response.text()).toBe('internal')
      await Promise.all([pinned.close(), trusted.close()])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
