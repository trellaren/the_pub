import type { AiProviderId, AiSettings } from '../../shared/model/ai.js'
import { errorMessage } from './providers.js'
import { normalize } from './vectors.js'

/**
 * Turning text into vectors.
 *
 * Every backend that can do this at all speaks OpenAI's `/v1/embeddings`,
 * including `llama-server`, so unlike the chat path there is no second dialect
 * to carry. What varies is only whether a backend offers the endpoint and which
 * model it should be asked for.
 *
 * The default source is the writer's own machine. Retrieval that silently
 * shipped a manuscript to a hosted embedder would undo the point of running a
 * model locally, so a hosted embedder is used only when the writer has already
 * chosen that provider for their chats — never as a fallback for a local one
 * that is unavailable.
 */

/** Texts per request. Large enough to matter, small enough to keep a body sane. */
export const EMBED_BATCH = 32

export interface EmbedderDeps {
  fetch?: typeof globalThis.fetch
}

export interface EmbedderConfig {
  provider: AiProviderId
  /** The embedding model to name, or empty for whatever the backend has loaded. */
  model: string
  /** Where to send. For `embedded` this is the running engine's own port. */
  baseUrl: string
  apiKey: string | null
}

/**
 * Where to ask for embeddings. Null when this backend has no such endpoint.
 *
 * Anthropic is the null: it serves no embeddings API, and pretending otherwise
 * would produce a 404 at the end of a long index build rather than an honest
 * refusal at the start of one.
 */
export function embeddingsUrl(config: Pick<EmbedderConfig, 'provider' | 'baseUrl'>): string | null {
  if (config.provider === 'anthropic') return null
  if (!config.baseUrl) return null
  return `${config.baseUrl.replace(/\/+$/, '')}/v1/embeddings`
}

/** What an embedder cannot do, said in a sentence a writer can act on. */
export function embedderRefusal(config: EmbedderConfig, providerName: string): string | null {
  if (config.provider === 'anthropic') {
    return `${providerName} has no embeddings API. Choose another provider, or use an embedded model, to build the retrieval index.`
  }
  if (!config.baseUrl) return `${providerName} has no address to send embeddings to.`
  return null
}

export class Embedder {
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(
    private readonly config: EmbedderConfig,
    deps: EmbedderDeps = {}
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch
  }

  /**
   * Embed a batch, in order.
   *
   * Throws rather than returning partial results: a caller writing vectors to
   * the index cannot tell a short array from a shifted one, and a silently
   * misaligned batch would attach every passage's vector to its neighbour.
   */
  async embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const url = embeddingsUrl(this.config)
    if (!url) throw new Error('This provider has no embeddings endpoint.')

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: JSON.stringify({
        input: texts,
        ...(this.config.model ? { model: this.config.model } : {}),
        encoding_format: 'float'
      }),
      signal: signal ?? null
    })

    if (!response.ok) {
      throw new Error(errorMessage(response.status, await response.text().catch(() => '')))
    }

    const vectors = parseEmbeddings(await response.json(), texts.length)
    if (!vectors) throw new Error('The embeddings response did not have the expected shape.')
    return vectors.map(normalize)
  }
}

/**
 * Read a response into one vector per input.
 *
 * Ordered by each item's own `index` rather than by array position: the field
 * exists in the API precisely because a server may answer out of order, and
 * trusting position instead would mislabel passages in a way nothing downstream
 * could detect. A response missing any index is refused whole.
 */
export function parseEmbeddings(body: unknown, expected: number): Float32Array[] | null {
  const parsed = body as { data?: { index?: unknown; embedding?: unknown }[] }
  if (!Array.isArray(parsed?.data) || parsed.data.length !== expected) return null

  const ordered: (Float32Array | undefined)[] = new Array(expected)
  parsed.data.forEach((item, position) => {
    const index = typeof item?.index === 'number' ? item.index : position
    if (index < 0 || index >= expected) return
    if (!Array.isArray(item?.embedding) || item.embedding.length === 0) return
    const vector = new Float32Array(item.embedding.length)
    for (let i = 0; i < item.embedding.length; i++) {
      const value = item.embedding[i]
      if (typeof value !== 'number' || !Number.isFinite(value)) return
      vector[i] = value
    }
    ordered[index] = vector
  })

  const complete = ordered.filter((vector): vector is Float32Array => vector !== undefined)
  return complete.length === expected ? complete : null
}

/** The embedder implied by a chat's resolved settings. */
export function embedderConfig(settings: AiSettings, apiKey: string | null): EmbedderConfig {
  return {
    provider: settings.provider,
    model: settings.embedModel,
    baseUrl: settings.baseUrl,
    apiKey
  }
}
