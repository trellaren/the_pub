import dns from 'node:dns/promises'
import { lookup as dnsLookup } from 'node:dns'
import type { ProjectSession } from '../services/projectSession.js'
import { describeProject } from './projectContext.js'
import { Agent, fetch as undiciFetch } from 'undici'
import { fetchPublic, pinnedLookup, type ResolveAll } from './webGate.js'

/** Long enough for a local model on a slow machine, short enough not to hang the card. */
export const PROMPT_TIMEOUT_MS = 30_000

/** The brief for a project whose storyboard or records could not be read. */
export function emptyFacts(session: ProjectSession): Parameters<typeof describeProject>[0] {
  return {
    name: session.manifest.name,
    projectType: session.manifest.projectType,
    documents: [],
    records: [],
    outlineBeats: [],
    openComments: null
  }
}

/** A page or a search that has not answered in this long is not going to. */
export const WEB_TIMEOUT_MS = 15_000
/** More than this is not an article; it is a download, and the model gets 12k characters anyway. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024

/**
 * Hostnames the e2e harness serves fixture pages behind on loopback, which the
 * address check would otherwise (rightly) refuse. Read under its own name so
 * nothing but the harness sets it by accident — the same arrangement as
 * `QUOTH_HIDDEN_WINDOWS`.
 */
const LOOPBACK_FIXTURE_HOSTS = new Set(
  (process.env.QUOTH_E2E_FIXTURE_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean)
)

/**
 * The dispatcher every page read connects through: its `lookup` re-checks the
 * addresses at connect time, so what `fetchPublic` checked is what is dialled.
 */
const isFixtureHost = (hostname: string): boolean => LOOPBACK_FIXTURE_HOSTS.has(hostname)

// Fixture hosts dial loopback directly rather than asking DNS, so the harness
// does not depend on `localtest.me` resolving wherever it runs.
const resolveForConnect: ResolveAll = (hostname, options, callback) =>
  isFixtureHost(hostname)
    ? callback(null, [{ address: '127.0.0.1', family: 4 }])
    : dnsLookup(hostname, { ...options, all: true }, (error, addresses) => callback(error, addresses ?? []))

const pinnedAgent = new Agent({
  connect: { lookup: pinnedLookup(isFixtureHost, resolveForConnect) }
})

const pinnedFetch = ((input: string, init?: RequestInit) =>
  undiciFetch(input, { ...(init as object), dispatcher: pinnedAgent })) as unknown as typeof fetch

/** `fetch` for the assistant's page reads: bounded in time and size, following no credentials. */
export async function fetchWithLimits(url: string): Promise<LimitedResponse> {
  const response = await fetchPublic(
    url,
    {
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      credentials: 'omit',
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' }
    },
    (hostname) =>
      isFixtureHost(hostname)
        ? Promise.resolve([{ address: '93.184.216.34' }])
        : dns.lookup(hostname, { all: true }),
    pinnedFetch
  )
  return limitedResponse(response)
}

type LimitedResponse = { ok: boolean; status: number; text(): Promise<string> }

/**
 * Size-capped view of a response. A declared length over the cap is refused
 * unread; otherwise the body is streamed and cancelled once the cap is
 * reached, so an endless or lying body costs at most `maxBytes` of memory.
 */
export function limitedResponse(response: Response, maxBytes = MAX_PAGE_BYTES): LimitedResponse {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {})
    return { ok: false, status: 413, text: async () => '' }
  }
  return {
    ok: response.ok,
    status: response.status,
    text: async () => new TextDecoder().decode(await readCapped(response, maxBytes))
  }
}

export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const room = maxBytes - total
      const chunk = value.byteLength > room ? value.subarray(0, room) : value
      chunks.push(chunk)
      total += chunk.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Standing orders every run opens with, ahead of the writer's own.
 *
 * Tools are always offered now, and a small local model told about eleven of
 * them tends to reach for one on every question. Saying plainly that a plain
 * answer is fine is what keeps "what is a good name for a dog" from costing a
 * manuscript search.
 */
export const ASSISTANT_PREAMBLE = [
  "You are the writing assistant inside Quoth, working on the author's project.",
  'Tools let you search and read the project and suggest changes the author then accepts or rejects; use them when the question is about the manuscript, and answer directly when it is not.',
  'Never claim to have changed a document: you only ever suggest.'
].join(' ')
