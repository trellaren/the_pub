import { describe, it, expect } from 'vitest'
import { TokenCache, type TokenStorage } from './tokens.js'
import { EXPIRY_MARGIN_MS, type Fetcher } from './oauth.js'

function setup(options: { stored?: string | null; replies?: unknown[] } = {}): {
  cache: TokenCache
  written: string[]
  refreshes: string[]
  storage: { stored: string | null }
} {
  const state = { stored: options.stored === undefined ? 'rt-0' : options.stored }
  const written: string[] = []
  const refreshes: string[] = []
  const replies = [...(options.replies ?? [])]
  let issued = 0

  const storage: TokenStorage = {
    account: (id) => (id === 'gone' ? null : { clientId: 'app-1', tenant: 'common', name: 'My drive' }),
    refreshToken: () => state.stored,
    storeRefreshToken: (_id, token) => {
      state.stored = token
      written.push(token)
    }
  }

  const fetcher: Fetcher = async (_url, init) => {
    refreshes.push(new URLSearchParams(init.body ?? '').get('refresh_token') ?? '')
    const reply = replies.shift()
    if (reply) return reply as ReturnType<Fetcher> extends Promise<infer R> ? R : never
    issued += 1
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: `at-${issued}`,
          refresh_token: `rt-${issued}`,
          expires_in: 3600
        })
    }
  }

  return { cache: new TokenCache(storage, fetcher), written, refreshes, storage: state }
}

describe('TokenCache', () => {
  it('refreshes on the first ask and reuses the result after', async () => {
    const { cache, refreshes } = setup()
    expect(await cache.access('p1')).toBe('at-1')
    expect(await cache.access('p1')).toBe('at-1')
    expect(refreshes).toEqual(['rt-0'])
  })

  it('stores the rotated refresh token immediately', async () => {
    // Microsoft invalidates the old one the moment it is spent, so keeping it
    // signs the author out at the next refresh — an hour later, with nothing
    // to connect the failure to.
    const { cache, written, storage } = setup()
    await cache.access('p1')
    expect(written).toEqual(['rt-1'])
    expect(storage.stored).toBe('rt-1')
  })

  it('spends a refresh token once, however many callers are waiting', async () => {
    // Autosave, the indexer and the file tree all reach the server at the same
    // moment; each spending the token the others were about to use would fail
    // all but one of them.
    const { cache, refreshes } = setup()
    const tokens = await Promise.all([cache.access('p1'), cache.access('p1'), cache.access('p1')])
    expect(tokens).toEqual(['at-1', 'at-1', 'at-1'])
    expect(refreshes).toEqual(['rt-0'])
  })

  it('refreshes again once the token is close to expiry', async () => {
    const { cache, refreshes } = setup()
    cache.adopt('p1', { accessToken: 'old', refreshToken: 'rt-9', expiresAt: Date.now() + EXPIRY_MARGIN_MS - 1 })
    expect(await cache.access('p1')).toBe('at-1')
    expect(refreshes).toEqual(['rt-9'])
  })

  it('keeps a token that has time left on it', async () => {
    const { cache, refreshes } = setup()
    cache.adopt('p1', { accessToken: 'fresh', refreshToken: 'rt-9', expiresAt: Date.now() + 3_600_000 })
    expect(await cache.access('p1')).toBe('fresh')
    expect(refreshes).toEqual([])
  })

  it('mints a new one after the server rejects the cached token', async () => {
    const { cache, refreshes } = setup()
    cache.adopt('p1', { accessToken: 'stale', refreshToken: 'rt-9', expiresAt: Date.now() + 3_600_000 })
    cache.invalidate('p1')
    expect(await cache.access('p1')).toBe('at-1')
    expect(refreshes).toEqual(['rt-9'])
  })

  it('says to sign in rather than failing at the network', async () => {
    const { cache } = setup({ stored: null })
    await expect(cache.access('p1')).rejects.toThrow(/Sign in to OneDrive for My drive/)
  })

  it('names a server that is no longer saved', async () => {
    const { cache } = setup()
    await expect(cache.access('gone')).rejects.toThrow(/no longer exists/)
  })

  it('lets the next caller try again after a refresh fails', async () => {
    // A failed refresh that left its promise cached would make one dropped
    // connection permanent for the rest of the session.
    const { cache } = setup({
      replies: [{ ok: false, status: 503, text: async () => JSON.stringify({ error: 'temporarily_unavailable' }) }]
    })
    await expect(cache.access('p1')).rejects.toThrow(/temporarily_unavailable/)
    expect(await cache.access('p1')).toBe('at-1')
  })

  it('hands the Graph client a source that refreshes for it', async () => {
    const { cache, refreshes } = setup()
    const source = cache.source('p1')
    expect(await source.get()).toBe('at-1')
    source.invalidate()
    expect(await source.get()).toBe('at-2')
    expect(refreshes).toEqual(['rt-0', 'rt-1'])
  })
})
