import { z } from 'zod'

/**
 * Where assistant-written prose came from, kept inside the document.
 *
 * Two records of the same fact, for two readers. The `aiAuthored` mark sits
 * on the text itself, so a reader hovering a sentence can see it was the
 * model's and when; it travels with the words and disappears with them. The
 * envelope-level `provenance` log is the record that does *not* disappear:
 * one entry per edit the assistant made, appended on write and never
 * removed, so a manuscript can always answer "did a model write any of this,
 * and what" — even after the writer deleted every trace from the prose.
 *
 * The log is append-only at the write boundary (`DocumentService.write`
 * unions the previous file's entries back in), not by asking the renderer
 * nicely. A writer may remove the words; they cannot remove the fact.
 */
export const AI_AUTHORED_MARK = 'aiAuthored'

export const aiAuthoredAttrsSchema = z.object({
  /** The agent run — a chat request id — so the entry and the mark can be paired. */
  runId: z.string().default(''),
  model: z.string().default(''),
  at: z.string().default(''),
  /** The assistant's author id; see `author.ts`. */
  authorId: z.string().default('')
})
export type AiAuthoredAttrs = z.infer<typeof aiAuthoredAttrsSchema>

export const provenanceEntrySchema = z.object({
  id: z.string(),
  runId: z.string().default(''),
  authorId: z.string().default(''),
  model: z.string().default(''),
  at: z.string(),
  /** Whether it arrived as a suggestion the writer accepted, or was written straight in. */
  mode: z.enum(['suggest', 'direct']),
  /** Which top-level block it landed in; null for an appended paragraph. */
  blockIndex: z.number().int().nullable().default(null),
  /** Characters of assistant prose, for a reader weighing how much is the model's. */
  chars: z.number().int().min(0).default(0),
  /** The first few words, so the entry is readable after the text is gone. */
  excerpt: z.string().default(''),
  reason: z.string().default('')
})
export type ProvenanceEntry = z.infer<typeof provenanceEntrySchema>

export const EXCERPT_CHARS = 80

export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat
}

/**
 * The entries a file must keep: everything it had, plus anything new, by id,
 * in the order first seen. The union is what makes the log append-only
 * without trusting any writer to remember to carry it forward.
 */
export function unionProvenance(
  previous: readonly ProvenanceEntry[] | undefined,
  incoming: readonly ProvenanceEntry[] | undefined
): ProvenanceEntry[] | undefined {
  if (!previous?.length && !incoming?.length) return incoming?.length ? [...incoming] : previous ? [] : undefined
  const seen = new Set<string>()
  const merged: ProvenanceEntry[] = []
  for (const entry of [...(previous ?? []), ...(incoming ?? [])]) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    merged.push(entry)
  }
  return merged
}

/** The writer's standing choice about how assistant prose may reach a document. */
export const writePolicies = ['suggest', 'direct-trivial', 'direct'] as const
export type WritePolicy = (typeof writePolicies)[number]

/**
 * A correction small enough that reviewing it costs more than it is worth:
 * the same words with a letter or two changed, or only punctuation and case.
 *
 * Judged word by word, with the allowance scaled to the word: two edits in
 * "recieved" is a typo, two edits in "was" is a different word ("lay"). A
 * change in the number of words is never trivial.
 */
export function isTrivial(find: string, replace: string): boolean {
  const before = find.trim()
  const after = replace.trim()
  if (!before || !after) return false
  if (before.toLowerCase() === after.toLowerCase()) return true
  const strip = (text: string): string => text.replace(/[\p{P}\p{S}]/gu, '').toLowerCase()
  if (strip(before) === strip(after)) return true

  const beforeWords = before.split(/\s+/)
  const afterWords = after.split(/\s+/)
  if (beforeWords.length !== afterWords.length) return false
  return beforeWords.every((word, index) => {
    const a = strip(word)
    const b = strip(afterWords[index]!)
    if (a === b) return true
    const allowance = Math.min(a.length, b.length) >= 5 ? 2 : 1
    return editDistance(a, b, allowance) <= allowance
  })
}

/** Levenshtein with an early exit, because anything past `limit` is "not trivial" either way. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
      current.push(value)
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > limit) return limit + 1
    previous = current
  }
  return previous[b.length]!
}
