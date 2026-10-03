import { describe, it, expect } from 'vitest'
import { buildWebGate, extractUrls, isPublicHttpUrl } from './webGate.js'

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
