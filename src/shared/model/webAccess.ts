import { z } from 'zod'
import { aiProviderIds, type AiProviderId } from './ai.js'

/**
 * How far the assistant may reach outside the project.
 *
 * `none` is the default and Phase 15's position: the model does not browse.
 * `urls` lets it read pages the writer has already named — in the chat or in
 * the bibliography — and nothing else. `search` adds a web search through a
 * provider the writer chose and keyed. App-scoped like `aiEnabled`: a shared
 * folder must not switch browsing on for a collaborator who left it off.
 */
export const webAccessLevels = ['none', 'urls', 'search'] as const
export const webAccessLevelSchema = z.enum(webAccessLevels)
export type WebAccessLevel = z.infer<typeof webAccessLevelSchema>

export const searchProviderIds = ['brave', 'tavily', 'searxng'] as const
export const searchProviderIdSchema = z.enum(searchProviderIds)
export type SearchProviderId = z.infer<typeof searchProviderIdSchema>

export interface SearchProviderInfo {
  id: SearchProviderId
  name: string
  needsKey: boolean
  /** Where a key comes from, shown beside the field. */
  keyUrl?: string
  /** Empty means the writer must supply one (a self-hosted instance). */
  defaultBaseUrl: string
}

export const SEARCH_PROVIDERS: SearchProviderInfo[] = [
  {
    id: 'brave',
    name: 'Brave Search',
    needsKey: true,
    keyUrl: 'https://api-dashboard.search.brave.com/app/keys',
    defaultBaseUrl: 'https://api.search.brave.com'
  },
  {
    id: 'tavily',
    name: 'Tavily',
    needsKey: true,
    keyUrl: 'https://app.tavily.com/home',
    defaultBaseUrl: 'https://api.tavily.com'
  },
  {
    id: 'searxng',
    name: 'SearXNG (self-hosted)',
    needsKey: false,
    defaultBaseUrl: ''
  }
]

export function searchProviderInfo(id: SearchProviderId): SearchProviderInfo {
  return SEARCH_PROVIDERS.find((provider) => provider.id === id)!
}

/**
 * Everything `AiKeyStore` can hold a secret for: the model providers, and the
 * search providers under a prefix so the two namespaces cannot collide.
 */
export const searchKeyId = (id: SearchProviderId): `search:${SearchProviderId}` => `search:${id}`
export const keyIds = [...aiProviderIds, ...searchProviderIds.map(searchKeyId)] as [KeyId, ...KeyId[]]
export type KeyId = AiProviderId | `search:${SearchProviderId}`
export const keyIdSchema = z.enum(keyIds)

/** One result from a web search, in the shape every provider is mapped to. */
export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}
