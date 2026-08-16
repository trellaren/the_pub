import { describe, it, expect, vi } from 'vitest'
import { Embedder, embeddingsUrl, embedderRefusal, parseEmbeddings } from './embedder.js'
import { dot } from './vectors.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('embeddingsUrl', () => {
  it('points at the OpenAI endpoint every capable backend serves', () => {
    expect(embeddingsUrl({ provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' })).toBe(
      'http://127.0.0.1:1234/v1/embeddings'
    )
    expect(embeddingsUrl({ provider: 'embedded', baseUrl: 'http://127.0.0.1:8080/' })).toBe(
      'http://127.0.0.1:8080/v1/embeddings'
    )
  })

  it('is null for a provider with no embeddings API', () => {
    expect(embeddingsUrl({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBeNull()
  })
})

describe('embedderRefusal', () => {
  it('names the problem and a way out rather than failing later', () => {
    const refusal = embedderRefusal(
      { provider: 'anthropic', model: '', baseUrl: 'https://api.anthropic.com', apiKey: 'k' },
      'Anthropic'
    )
    expect(refusal).toContain('no embeddings API')
    expect(refusal).toContain('embedded model')
  })

  it('is null when the backend can be asked', () => {
    expect(
      embedderRefusal({ provider: 'embedded', model: '', baseUrl: 'http://127.0.0.1:1', apiKey: null }, 'Embedded')
    ).toBeNull()
  })
})

describe('parseEmbeddings', () => {
  it('orders by each item’s own index, not its position', () => {
    // The field exists because a server may answer out of order. Trusting
    // position instead would attach each passage's vector to another passage,
    // and nothing downstream could tell.
    const vectors = parseEmbeddings(
      { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] },
      2
    )
    expect(vectors?.map((vector) => [...vector])).toEqual([
      [1, 0],
      [0, 1]
    ])
  })

  it('refuses a response with the wrong count, a gap, or a non-number', () => {
    expect(parseEmbeddings({ data: [{ index: 0, embedding: [1] }] }, 2)).toBeNull()
    expect(parseEmbeddings({ data: [{ index: 5, embedding: [1] }] }, 1)).toBeNull()
    expect(parseEmbeddings({ data: [{ index: 0, embedding: ['x'] }] }, 1)).toBeNull()
    expect(parseEmbeddings({ data: [{ index: 0, embedding: [Number.NaN] }] }, 1)).toBeNull()
    expect(parseEmbeddings({}, 1)).toBeNull()
  })
})

describe('Embedder', () => {
  it('sends the batch and returns normalised vectors', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({ data: [{ index: 0, embedding: [3, 4] }, { index: 1, embedding: [0, 5] }] })
    )
    const embedder = new Embedder(
      { provider: 'lmstudio', model: 'nomic-embed', baseUrl: 'http://127.0.0.1:1234', apiKey: null },
      { fetch: fetchImpl as unknown as typeof globalThis.fetch }
    )

    const vectors = await embedder.embed(['one', 'two'])
    // Normalised on the way in, so the search itself is a dot product.
    expect(dot(vectors[0]!, vectors[0]!)).toBeCloseTo(1, 5)

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body)
    expect(body.input).toEqual(['one', 'two'])
    expect(body.model).toBe('nomic-embed')
  })

  it('omits the model when the backend serves whatever it has loaded', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({ data: [{ index: 0, embedding: [1] }] })
    )
    const embedder = new Embedder(
      { provider: 'embedded', model: '', baseUrl: 'http://127.0.0.1:9', apiKey: null },
      { fetch: fetchImpl as unknown as typeof globalThis.fetch }
    )

    await embedder.embed(['one'])
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).not.toHaveProperty('model')
  })

  it('throws on an error status, with the provider’s own message', async () => {
    const embedder = new Embedder(
      { provider: 'openai', model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com', apiKey: 'k' },
      {
        fetch: (async () =>
          jsonResponse({ error: { message: 'model not found' } }, 404)) as unknown as typeof globalThis.fetch
      }
    )
    await expect(embedder.embed(['one'])).rejects.toThrow('model not found')
  })

  it('throws rather than returning a short batch', async () => {
    // A caller writing these to the index cannot tell a short array from a
    // shifted one, so a partial result is worse than no result.
    const embedder = new Embedder(
      { provider: 'lmstudio', model: '', baseUrl: 'http://127.0.0.1:1234', apiKey: null },
      {
        fetch: (async () =>
          jsonResponse({ data: [{ index: 0, embedding: [1] }] })) as unknown as typeof globalThis.fetch
      }
    )
    await expect(embedder.embed(['one', 'two'])).rejects.toThrow('expected shape')
  })

  it('does not send at all when the provider has no endpoint', async () => {
    const fetchImpl = vi.fn()
    const embedder = new Embedder(
      { provider: 'anthropic', model: '', baseUrl: 'https://api.anthropic.com', apiKey: 'k' },
      { fetch: fetchImpl as unknown as typeof globalThis.fetch }
    )
    await expect(embedder.embed(['one'])).rejects.toThrow('no embeddings endpoint')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
