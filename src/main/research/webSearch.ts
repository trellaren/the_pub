import {
  searchProviderInfo,
  type SearchProviderId,
  type WebSearchHit
} from '../../shared/model/webAccess.js'

/** The subset of `fetch` this module uses, so a test can supply one by hand — see `capture.ts`. */
export type SearchFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface SearchOptions {
  apiKey: string | null
  /** Overrides the provider's default; required for a self-hosted SearXNG. */
  baseUrl: string
  fetchImpl: SearchFetch
}

export type SearchOutcome =
  | { ok: true; hits: WebSearchHit[] }
  | { ok: false; reason: 'no-key' | 'no-url' | 'offline' | 'refused' | 'malformed' }

/**
 * One web search, through whichever provider the writer chose.
 *
 * Three providers behind one function, each a URL, a header and a mapping —
 * the same shape `providers.ts` gives the model backends, and for the same
 * reason: everything above this line should not care which one it is. Brave
 * is the suggested default (a plain GET with a token header and a generous
 * free tier); Tavily is the other hosted option; SearXNG is for a writer who
 * runs their own and wants nothing leaving their network.
 */
export async function webSearch(
  provider: SearchProviderId,
  query: string,
  limit: number,
  options: SearchOptions
): Promise<SearchOutcome> {
  const info = searchProviderInfo(provider)
  const baseUrl = (options.baseUrl || info.defaultBaseUrl).replace(/\/+$/, '')
  if (!baseUrl) return { ok: false, reason: 'no-url' }
  if (info.needsKey && !options.apiKey) return { ok: false, reason: 'no-key' }

  const request = buildSearchRequest(provider, baseUrl, query, limit, options.apiKey)
  let response: Awaited<ReturnType<SearchFetch>>
  try {
    response = await options.fetchImpl(request.url, request.init)
  } catch {
    return { ok: false, reason: 'offline' }
  }
  if (!response.ok) return { ok: false, reason: response.status === 401 || response.status === 403 ? 'refused' : 'offline' }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const hits = parseSearchResults(provider, payload).slice(0, limit)
  return { ok: true, hits }
}

export function buildSearchRequest(
  provider: SearchProviderId,
  baseUrl: string,
  query: string,
  limit: number,
  apiKey: string | null
): { url: string; init: { method: string; headers: Record<string, string>; body?: string } } {
  const count = String(Math.max(1, Math.min(limit, 10)))
  switch (provider) {
    case 'brave':
      return {
        url: `${baseUrl}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
        init: { method: 'GET', headers: { accept: 'application/json', 'x-subscription-token': apiKey ?? '' } }
      }
    case 'tavily':
      return {
        url: `${baseUrl}/search`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey ?? ''}` },
          body: JSON.stringify({ query, max_results: Number(count) })
        }
      }
    case 'searxng':
      return {
        url: `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`,
        init: { method: 'GET', headers: { accept: 'application/json' } }
      }
  }
}

/** Each provider's payload into the one shape, dropping anything without a usable URL. */
export function parseSearchResults(provider: SearchProviderId, payload: unknown): WebSearchHit[] {
  if (typeof payload !== 'object' || payload === null) return []
  const root = payload as Record<string, unknown>
  const rows: unknown[] =
    provider === 'brave'
      ? asArray((root.web as Record<string, unknown> | undefined)?.results)
      : asArray(root.results)

  const hits: WebSearchHit[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    const url = text(item.url)
    if (!url) continue
    hits.push({
      title: text(item.title) || url,
      url,
      snippet: text(provider === 'brave' ? item.description : item.content) || ''
    })
  }
  return hits
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
