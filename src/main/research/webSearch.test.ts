import { describe, it, expect } from 'vitest'
import { webSearch, buildSearchRequest, parseSearchResults, type SearchFetch } from './webSearch.js'

function respond(status: number, body: unknown): SearchFetch {
  return async () => ({ ok: status < 400, status, json: async () => body })
}

const brave = {
  web: {
    results: [
      { title: 'Lisbon docks, 1954', url: 'https://example.org/docks', description: 'Wages on the quay.' },
      { title: 'No url here' },
      { url: 'https://example.org/untitled' }
    ]
  }
}
const tavily = { results: [{ title: 'Docks', url: 'https://example.org/docks', content: 'Wages on the quay.' }] }
const searxng = { results: [{ title: 'Docks', url: 'https://example.org/docks', content: 'Wages on the quay.' }] }

describe('buildSearchRequest', () => {
  it('speaks each provider\'s dialect', () => {
    expect(buildSearchRequest('brave', 'https://api.search.brave.com', 'lisbon docks', 5, 'k')).toMatchObject({
      url: 'https://api.search.brave.com/res/v1/web/search?q=lisbon%20docks&count=5',
      init: { method: 'GET', headers: { 'x-subscription-token': 'k' } }
    })
    const t = buildSearchRequest('tavily', 'https://api.tavily.com', 'q', 3, 'k')
    expect(t.url).toBe('https://api.tavily.com/search')
    expect(JSON.parse(t.init.body!)).toEqual({ query: 'q', max_results: 3 })
    expect(t.init.headers.authorization).toBe('Bearer k')
    expect(buildSearchRequest('searxng', 'http://searx.local', 'q', 3, null).url).toBe('http://searx.local/search?q=q&format=json')
  })

  it('clamps the count to what providers accept', () => {
    expect(buildSearchRequest('brave', 'https://b', 'q', 50, 'k').url).toContain('count=10')
    expect(buildSearchRequest('brave', 'https://b', 'q', 0, 'k').url).toContain('count=1')
  })
})

describe('parseSearchResults', () => {
  it('maps every provider to one shape and drops rows with no url', () => {
    expect(parseSearchResults('brave', brave)).toEqual([
      { title: 'Lisbon docks, 1954', url: 'https://example.org/docks', snippet: 'Wages on the quay.' },
      { title: 'https://example.org/untitled', url: 'https://example.org/untitled', snippet: '' }
    ])
    expect(parseSearchResults('tavily', tavily)).toEqual([
      { title: 'Docks', url: 'https://example.org/docks', snippet: 'Wages on the quay.' }
    ])
    expect(parseSearchResults('searxng', searxng)).toHaveLength(1)
    expect(parseSearchResults('brave', null)).toEqual([])
    expect(parseSearchResults('tavily', { results: 'nope' })).toEqual([])
  })
})

describe('webSearch', () => {
  it('refuses before the network when a keyed provider has no key, or a self-hosted one no address', async () => {
    expect(await webSearch('brave', 'q', 5, { apiKey: null, baseUrl: '', fetchImpl: respond(200, brave) })).toEqual({ ok: false, reason: 'no-key' })
    expect(await webSearch('searxng', 'q', 5, { apiKey: null, baseUrl: '', fetchImpl: respond(200, searxng) })).toEqual({ ok: false, reason: 'no-url' })
  })

  it('returns hits, limited to what was asked for', async () => {
    const result = await webSearch('brave', 'q', 1, { apiKey: 'k', baseUrl: '', fetchImpl: respond(200, brave) })
    expect(result).toEqual({ ok: true, hits: [expect.objectContaining({ url: 'https://example.org/docks' })] })
  })

  it('tells a bad key from an outage from a broken reply', async () => {
    expect(await webSearch('brave', 'q', 1, { apiKey: 'k', baseUrl: '', fetchImpl: respond(401, {}) })).toEqual({ ok: false, reason: 'refused' })
    expect(await webSearch('brave', 'q', 1, { apiKey: 'k', baseUrl: '', fetchImpl: respond(503, {}) })).toEqual({ ok: false, reason: 'offline' })
    const failing: SearchFetch = async () => {
      throw new Error('ENOTFOUND')
    }
    expect(await webSearch('brave', 'q', 1, { apiKey: 'k', baseUrl: '', fetchImpl: failing })).toEqual({ ok: false, reason: 'offline' })
    const broken: SearchFetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
    expect(await webSearch('brave', 'q', 1, { apiKey: 'k', baseUrl: '', fetchImpl: broken })).toEqual({ ok: false, reason: 'malformed' })
  })
})
