import { z } from 'zod'
import type { TextBlock } from '../../shared/pm/extractText.js'
import type { AssistantEditOp } from '../../shared/pm/assistantEdits.js'

/**
 * A proofreading pass, as data in and data out.
 *
 * The model is shown numbered blocks and asked for corrections as JSON; every
 * correction is then checked against the block it names before it becomes an
 * edit op. The check is the whole safety of the feature: a model that quotes
 * a word that is not there, or one that is there twice, has described a
 * change nobody can place, and placing it anyway would strike through the
 * wrong words. Such findings are dropped and counted, never guessed at.
 *
 * Nothing here touches a document or a provider. The tool around it does the
 * reading and the asking; this is what can be tested with a string.
 */
export const PROOFREAD_KINDS = ['spelling', 'grammar', 'punctuation', 'style'] as const
export type ProofreadKind = (typeof PROOFREAD_KINDS)[number]

/** Characters of prose per request. Big enough to carry context, small enough to answer in one reply. */
export const PROOFREAD_CHUNK_CHARS = 6_000
/**
 * Requests one tool call may make. Separate from the agent's own step budget,
 * because a chapter is many chunks and one tool call should proofread a
 * chapter — but a whole novel in one call is a run nobody is watching.
 */
export const MAX_PROOFREAD_CALLS = 12

/** Whole blocks, never split: a correction is addressed by block, and a half-block has no number. */
export function chunkBlocks(blocks: readonly TextBlock[], maxChars = PROOFREAD_CHUNK_CHARS): TextBlock[][] {
  const chunks: TextBlock[][] = []
  let current: TextBlock[] = []
  let size = 0
  for (const block of blocks) {
    if (!block.text.trim()) continue
    if (current.length > 0 && size + block.text.length > maxChars) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(block)
    size += block.text.length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function proofreadPrompt(
  chunk: readonly TextBlock[],
  kinds: readonly ProofreadKind[],
  lang: string
): { system: string; user: string } {
  const language = lang ? ` The text is written in ${lang}; follow that language's conventions.` : ''
  const system = [
    'You are a careful copy editor.',
    `Find ${kinds.join(', ')} problems in the numbered paragraphs and reply with corrections only.`,
    language,
    'Reply with a JSON array and nothing else. Each item: {"block": <paragraph number>, "find": "<the exact words to change, copied verbatim, long enough to occur once in that paragraph>", "replace": "<the corrected words>", "reason": "<a few words>", "kind": "<' +
      kinds.join('|') +
      '>"}.',
    'Keep `find` short — a word or a phrase, never a whole sentence unless the whole sentence changes.',
    'Do not rewrite for taste unless asked for style. Preserve the author\'s voice, dialect and deliberate choices. Reply with [] when nothing needs changing.'
  ]
    .filter(Boolean)
    .join(' ')
  const user = chunk.map((block) => `[${block.index}] ${block.text}`).join('\n\n')
  return { system, user }
}

const findingSchema = z.object({
  block: z.number().int().min(0),
  find: z.string().min(1),
  replace: z.string(),
  reason: z.string().default(''),
  kind: z.enum(PROOFREAD_KINDS).default('spelling')
})
export type Finding = z.infer<typeof findingSchema>

export interface PlacedFinding {
  op: Extract<AssistantEditOp, { kind: 'replace' }>
  kind: ProofreadKind
}

export interface ParsedFindings {
  placed: PlacedFinding[]
  /** Findings that named text not in the block, or in it more than once. */
  dropped: number
}

/**
 * Turn the model's reply into ops it is safe to apply.
 *
 * Lenient about the wrapping — fenced JSON, prose around it — and strict
 * about the contents: a finding is placed only when its `find` occurs exactly
 * once in the block it names, measured in the same normalised text the walker
 * produces, so the offsets are the ones `applyAssistantEdit` expects.
 */
export function parseFindings(raw: string, chunk: readonly TextBlock[]): ParsedFindings {
  const byIndex = new Map(chunk.map((block) => [block.index, block]))
  const items = extractArray(raw)
  const placed: PlacedFinding[] = []
  let dropped = 0
  const taken = new Map<number, { start: number; end: number }[]>()

  for (const item of items) {
    const parsed = findingSchema.safeParse(item)
    if (!parsed.success) {
      dropped += 1
      continue
    }
    const finding = parsed.data
    const block = byIndex.get(finding.block)
    if (!block || finding.find === finding.replace) {
      dropped += 1
      continue
    }
    const start = block.text.indexOf(finding.find)
    if (start === -1 || block.text.indexOf(finding.find, start + 1) !== -1) {
      dropped += 1
      continue
    }
    const end = start + finding.find.length
    // Two findings over the same words would strike the same text twice.
    const ranges = taken.get(block.index) ?? []
    if (ranges.some((range) => start < range.end && range.start < end)) {
      dropped += 1
      continue
    }
    ranges.push({ start, end })
    taken.set(block.index, ranges)
    placed.push({
      kind: finding.kind,
      op: {
        kind: 'replace',
        blockIndex: block.index,
        start,
        end,
        text: finding.replace,
        reason: finding.reason ? `${finding.kind}: ${finding.reason}` : finding.kind
      }
    })
  }
  return { placed, dropped }
}

function extractArray(raw: string): unknown[] {
  const unfenced = raw.replace(/```(?:json)?/gi, '')
  const first = unfenced.indexOf('[')
  const last = unfenced.lastIndexOf(']')
  if (first === -1 || last <= first) return []
  try {
    const value: unknown = JSON.parse(unfenced.slice(first, last + 1))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

/** "14 suggestions (9 spelling, 5 grammar)" — the summary a person reads in the trail. */
export function describeFindings(placed: readonly PlacedFinding[]): string {
  if (placed.length === 0) return 'no corrections'
  const counts = new Map<ProofreadKind, number>()
  for (const finding of placed) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1)
  const parts = PROOFREAD_KINDS.filter((kind) => counts.has(kind)).map((kind) => `${counts.get(kind)} ${kind}`)
  return `${placed.length} suggestion${placed.length === 1 ? '' : 's'} (${parts.join(', ')})`
}
