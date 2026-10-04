import dns from 'node:dns/promises'
import type { ProjectSession } from '../services/projectSession.js'
import { describeProject } from './projectContext.js'
import { fetchPublic } from './webGate.js'

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

/** `fetch` for the assistant's page reads: bounded in time and size, following no credentials. */
export async function fetchWithLimits(
  url: string
): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  const response = await fetchPublic(
    url,
    {
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      credentials: 'omit',
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' }
    },
    (hostname) =>
      LOOPBACK_FIXTURE_HOSTS.has(hostname)
        ? Promise.resolve([{ address: '93.184.216.34' }])
        : dns.lookup(hostname, { all: true })
  )
  return {
    ok: response.ok,
    status: response.status,
    text: async () => {
      const bytes = await response.arrayBuffer()
      return new TextDecoder().decode(bytes.slice(0, MAX_PAGE_BYTES))
    }
  }
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
