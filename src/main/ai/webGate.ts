import type { WebAccessLevel } from '../../shared/model/webAccess.js'

/**
 * What the writer has allowed the assistant to reach on the web.
 *
 * Built once per run from the app setting and the URLs the writer has
 * already put in front of the assistant — in this chat, or in the project's
 * bibliography. Under `urls` those are the only pages it may fetch; under
 * `search` any public page is fair game; under `none` the tools are not
 * offered at all, so there is nothing to refuse.
 */
export interface WebGate {
  level: WebAccessLevel
  canSearch: boolean
  allows: (url: string) => boolean
}

export function buildWebGate(level: WebAccessLevel, writerUrls: Iterable<string> = []): WebGate {
  const allowed = new Set([...writerUrls].map(normalizeUrl).filter(Boolean))
  return {
    level,
    canSearch: level === 'search',
    allows: (url) => {
      if (level === 'none') return false
      if (!isPublicHttpUrl(url)) return false
      return level === 'search' || allowed.has(normalizeUrl(url))
    }
  }
}

/** URLs in free text, for the pages a writer named in their own messages. */
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"'`)\]]+/gi) ?? []
  return found.map((url) => url.replace(/[.,;:!?]+$/, ''))
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

/**
 * Only the public web.
 *
 * The fetch runs in the main process, on the writer's machine, with whatever
 * that machine can reach — a router's admin page, a database on the LAN, the
 * cloud metadata endpoint. A model that can be talked into fetching
 * `http://169.254.169.254/` must find the door already shut.
 */
export function isPublicHttpUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false
  }
  if (!host.includes('.') && !host.includes(':')) return false
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127 || a === 0) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a >= 224) return false
    return true
  }
  if (host.includes(':')) {
    // IPv6: loopback, unspecified, link-local, unique-local and v4-mapped.
    const lower = host
    if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return false
    if (lower.startsWith('::ffff:')) return false
    return true
  }
  return true
}
