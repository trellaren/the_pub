import { describe, it, expect } from 'vitest'
import {
  GraphClient,
  GraphError,
  itemUrl,
  pathOfItem,
  itemMtime,
  backoffFor,
  GRAPH_BASE,
  type HttpFetch,
  type HttpResponse,
  type TokenSource
} from './graph.js'

interface Reply {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

function response(reply: Reply): HttpResponse {
  const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    headers: { get: (name) => reply.headers?.[name.toLowerCase()] ?? null },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer
  }
}

/** A Graph that answers with a queued script, remembering how it was called. */
function server(replies: Reply[]): {
  fetch: HttpFetch
  calls: { url: string; method: string; auth: string }[]
  waits: number[]
  client: GraphClient
  tokens: { minted: number }
} {
  const calls: { url: string; method: string; auth: string }[] = []
  const waits: number[] = []
  const state = { minted: 0 }
  let token = 'token-0'

  const tokens: TokenSource = {
    get: async () => {
      state.minted += 1
      return token
    },
    invalidate: () => {
      token = 'token-1'
    }
  }

  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization ?? '' })
    return response(replies.shift() ?? { status: 500, body: { error: { message: 'no reply queued' } } })
  }

  const client = new GraphClient({
    tokens,
    fetch,
    sleep: async (ms) => {
      waits.push(ms)
    }
  })
  return { fetch, calls, waits, client, tokens: state }
}

describe('itemUrl', () => {
  it('addresses the drive root without a path fence', () => {
    // `/root:/:` is not a URL Graph accepts, so the empty path is its own case.
    expect(itemUrl('')).toBe(`${GRAPH_BASE}/me/drive/root`)
    expect(itemUrl('/')).toBe(`${GRAPH_BASE}/me/drive/root`)
    expect(itemUrl('', '/children')).toBe(`${GRAPH_BASE}/me/drive/root/children`)
  })

  it('fences a path only when something follows it', () => {
    expect(itemUrl('Novel/ch1.pubdoc')).toBe(`${GRAPH_BASE}/me/drive/root:/Novel/ch1.pubdoc`)
    expect(itemUrl('Novel', '/children')).toBe(`${GRAPH_BASE}/me/drive/root:/Novel:/children`)
  })

  it('escapes what a filename is allowed to contain', () => {
    // Spaces, ampersands and hashes are all legal in a chapter title and all
    // change the meaning of a URL.
    expect(itemUrl('My Book/Chapter #1 & co.pubdoc')).toBe(
      `${GRAPH_BASE}/me/drive/root:/My%20Book/Chapter%20%231%20%26%20co.pubdoc`
    )
  })
})

describe('pathOfItem', () => {
  it('reads the path out of a personal drive item', () => {
    expect(pathOfItem({ name: 'ch1.pubdoc', parentReference: { path: '/drive/root:/Novel' } })).toBe(
      'Novel/ch1.pubdoc'
    )
  })

  it('reads it out of a business drive item too', () => {
    expect(
      pathOfItem({ name: 'ch1.pubdoc', parentReference: { path: '/drives/b!abc/root:/Novel/parts' } })
    ).toBe('Novel/parts/ch1.pubdoc')
  })

  it('handles an item sitting at the drive root', () => {
    expect(pathOfItem({ name: 'notes.md', parentReference: { path: '/drive/root:' } })).toBe('notes.md')
  })

  it('un-escapes what Graph escaped', () => {
    expect(pathOfItem({ name: 'ch 1.pubdoc', parentReference: { path: '/drive/root:/My%20Book' } })).toBe(
      'My Book/ch 1.pubdoc'
    )
  })

  it('declines the delta root, which names no file', () => {
    expect(pathOfItem({ name: 'root' })).toBeNull()
    expect(pathOfItem({ parentReference: { path: '/drive/root:' } })).toBeNull()
  })
})

describe('itemMtime', () => {
  it('is epoch milliseconds, matching every other backend', () => {
    expect(itemMtime({ lastModifiedDateTime: '2026-01-02T03:04:05Z' })).toBe(
      Date.parse('2026-01-02T03:04:05Z')
    )
    expect(itemMtime({})).toBe(0)
    expect(itemMtime({ lastModifiedDateTime: 'never' })).toBe(0)
  })
})

describe('GraphClient', () => {
  it('signs every request with the current token', async () => {
    const { client, calls } = server([{ status: 200, body: { value: [] } }])
    await client.json('GET', itemUrl('', '/children'))
    expect(calls[0]!.auth).toBe('Bearer token-0')
  })

  it('refreshes once when the token is refused, and does not loop', async () => {
    // A token that ages out between minting and sending is a certainty on a
    // long upload, not a failure worth showing anyone.
    const { client, calls } = server([
      { status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } },
      { status: 200, body: { name: 'ch1.pubdoc' } }
    ])
    const item = await client.json<{ name: string }>('GET', itemUrl('ch1.pubdoc'))
    expect(item.name).toBe('ch1.pubdoc')
    expect(calls.map((call) => call.auth)).toEqual(['Bearer token-0', 'Bearer token-1'])
  })

  it('gives up on a second refusal rather than refreshing forever', async () => {
    const { client, calls } = server([
      { status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } },
      { status: 401, body: { error: { message: 'Access token has expired.' } } }
    ])
    await expect(client.json('GET', itemUrl('ch1.pubdoc'))).rejects.toThrow(/expired/)
    expect(calls).toHaveLength(2)
  })

  it('waits exactly as long as Microsoft asked when throttled', async () => {
    const { client, waits, calls } = server([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: { ok: true } }
    ])
    await client.json('GET', itemUrl(''))
    expect(waits).toEqual([2000])
    expect(calls).toHaveLength(2)
  })

  it('backs off on its own when it was not told how long', async () => {
    const { client, waits } = server([
      { status: 503 },
      { status: 503 },
      { status: 200, body: { ok: true } }
    ])
    await client.json('GET', itemUrl(''))
    expect(waits).toEqual([500, 1000])
  })

  it('never blocks a save for longer than a person would wait', async () => {
    // Honouring a five-minute Retry-After literally is indistinguishable from
    // a hung app; the request is retried sooner and fails honestly instead.
    expect(backoffFor(response({ status: 429, headers: { 'retry-after': '300' } }), 0)).toBe(10_000)
    expect(backoffFor(response({ status: 429, headers: { 'retry-after': 'soon' } }), 1)).toBe(1000)
  })

  it('stops retrying eventually and reports why', async () => {
    const { client, calls } = server(Array.from({ length: 6 }, () => ({ status: 429 })))
    await expect(client.json('GET', itemUrl(''))).rejects.toThrow(/HTTP 429/)
    expect(calls).toHaveLength(5) // the first try plus four retries
  })

  it('marks a missing item as missing, whatever the status says', async () => {
    const { client } = server([{ status: 404, body: { error: { code: 'itemNotFound', message: 'gone' } } }])
    const error = await client.json('GET', itemUrl('nope')).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(GraphError)
    expect((error as GraphError).notFound).toBe(true)
  })

  it('does not retry a refusal that will never succeed', async () => {
    const { client, calls, waits } = server([
      { status: 403, body: { error: { code: 'accessDenied', message: 'Access denied' } } }
    ])
    await expect(client.json('GET', itemUrl(''))).rejects.toThrow(/Access denied/)
    expect(calls).toHaveLength(1)
    expect(waits).toEqual([])
  })

  it('reads a body as bytes without going through a string', async () => {
    const { client } = server([{ status: 200, body: 'chapter one' }])
    expect((await client.bytes(itemUrl('ch1.pubdoc', '/content'))).toString('utf8')).toBe('chapter one')
  })

  it('treats an empty response body as nothing rather than a parse error', async () => {
    // A DELETE answers 204 with no body, and JSON.parse('') throws.
    const { client } = server([{ status: 204, body: '' }])
    expect(await client.json('DELETE', itemUrl('ch1.pubdoc'))).toEqual({})
  })
})
