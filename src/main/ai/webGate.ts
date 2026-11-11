import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
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
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPublicIPv4(host)
  if (host.includes(':')) return isPublicIPv6(host)
  return true
}

export function isPublicIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 10 || a === 127 || a === 0) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  // Benchmarking range, routed to test labs and sometimes to internal gear.
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a >= 224) return false
  return true
}

function expandIPv6(address: string): number[] | null {
  let text = address.toLowerCase().split('%')[0]!
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (v4) {
    const octets = v4[1]!.split('.').map(Number)
    text = `${text.slice(0, v4.index)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  const values = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN))
  return values.some(Number.isNaN) ? null : values
}

export function isPublicIPv6(address: string): boolean {
  const groups = expandIPv6(address)
  if (!groups) return false
  const first = groups[0]!
  // Every `::`-prefixed form (loopback, unspecified, v4-mapped, v4-compatible)
  // embeds or aliases a non-global address; no public IPv6 address starts so.
  if (first === 0) return false
  if ((first & 0xfe00) === 0xfc00) return false // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return false // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return false // fec0::/10 site-local
  if ((first & 0xff00) === 0xff00) return false // multicast
  // NAT64: the low 32 bits are an IPv4 address, private ones included.
  if (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return false
  return true
}

export function isPublicAddress(address: string): boolean {
  return address.includes(':') ? isPublicIPv6(address) : isPublicIPv4(address)
}

export type LookupAll = (hostname: string) => Promise<{ address: string }[]>

/**
 * `isPublicHttpUrl`, plus what the hostname actually resolves to. A public
 * name can point at a private address (`127.0.0.1.nip.io`), which a check of
 * the URL text alone lets through.
 */
export async function resolvesPublic(url: string, lookup: LookupAll): Promise<boolean> {
  if (!isPublicHttpUrl(url)) return false
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  if (/^[\d.]+$/.test(host) || host.includes(':')) return true
  let addresses: { address: string }[]
  try {
    addresses = await lookup(host)
  } catch {
    return false
  }
  return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address))
}

const MAX_REDIRECTS = 5

/**
 * Fetch a page, re-checking every redirect hop. `fetch` follows redirects on
 * its own by default, so a public page answering `302 Location:
 * http://169.254.169.254/` would otherwise walk straight past the gate.
 */
export async function fetchPublic(
  url: string,
  init: RequestInit,
  lookup: LookupAll,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await resolvesPublic(current, lookup))) {
      throw new Error(`Refused to fetch a non-public address: ${current}`)
    }
    const response = await fetchImpl(current, { ...init, redirect: 'manual' })
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) return response
    current = new URL(location, current).toString()
  }
  throw new Error('Too many redirects.')
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/**
 * A `lookup` for the socket itself, so the address checked is the address
 * dialled. Checking a name and then letting `fetch` resolve it again leaves a
 * window for DNS rebinding: a short-TTL name answers public for the check and
 * `127.0.0.1` for the connection. Here every address the connection could use
 * is checked as it is handed to the socket.
 *
 * `trusted` names skip the check — the e2e harness's loopback fixture hosts.
 */
export type ResolveAll = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void

const resolveWithDns: ResolveAll = (hostname, options, callback) =>
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => callback(error, addresses ?? []))

export function pinnedLookup(
  trusted: (hostname: string) => boolean = () => false,
  resolve: ResolveAll = resolveWithDns
): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    resolve(hostname, options, (error, list) => {
      if (error) return callback(error, [])
      if (!trusted(hostname) && (list.length === 0 || !list.every(({ address }) => isPublicAddress(address)))) {
        const refused: NodeJS.ErrnoException = new Error(`Refused to connect to a non-public address for ${hostname}`)
        refused.code = 'ENOTPUBLIC'
        return callback(refused, [])
      }
      if (options.all) return callback(null, list)
      const first = list[0]!
      callback(null, first.address, first.family)
    })
  }
}
