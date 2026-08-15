import type { TextBlock } from './extractText.js'
import { diffSequences } from './lcsDiff.js'

/**
 * Comparing two versions of a document, in the terms an author thinks in.
 *
 * A plain sequence diff over blocks is not enough on its own. It has no concept
 * of a paragraph that *moved* — it reports one deleted here and an unrelated one
 * inserted there, which is exactly the reading a person does not want when they
 * dragged a scene three pages later. Nor of a paragraph that was *edited*: a
 * changed line reads as a whole paragraph gone and a whole paragraph arrived,
 * burying a one-word fix in two walls of highlight.
 *
 * So the sequence diff runs first, and then two passes reinterpret what it
 * found: identical text on both sides is a move, and a delete/insert pair that
 * still resemble each other is an edit, diffed again word by word inside.
 */

export type BlockDiffKind = 'unchanged' | 'added' | 'removed' | 'moved' | 'changed'

export interface BlockDiffEntry {
  kind: BlockDiffKind
  /** Where it was, if it was there before. */
  oldIndex: number | null
  /** Where it is now, if it is still there. */
  newIndex: number | null
  text: string
  /** Only for `changed`: the edit within the paragraph. */
  words?: WordDiffEntry[]
}

export type WordDiffKind = 'equal' | 'insert' | 'delete'

export interface WordDiffEntry {
  kind: WordDiffKind
  text: string
}

/**
 * How alike two paragraphs are, from 0 to 1, by the words they share.
 *
 * Dice over word sets, which ignores order — a sentence whose clauses were
 * swapped is still recognisably the same sentence, and should be shown as an
 * edit rather than a replacement.
 */
export function similarity(a: string, b: string): number {
  const left = new Set(tokenise(a))
  const right = new Set(tokenise(b))
  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return (2 * shared) / (left.size + right.size)
}

/**
 * How alike two paragraphs must be to count as an edit of one another.
 *
 * Deliberately permissive. A heavily rewritten paragraph is still that
 * paragraph being rewritten, and showing it as one edit is more use than
 * showing it as an unrelated loss and an unrelated arrival. A genuinely
 * different paragraph shares little more than its articles and falls well
 * under this.
 */
const SAME_PARAGRAPH = 0.3

/** Word-level diff, keeping the spaces so the text can be rebuilt exactly. */
export function diffWords(oldText: string, newText: string): WordDiffEntry[] {
  const ops = diffSequences(splitWords(oldText), splitWords(newText))
  return ops.flatMap((op) => {
    const text = op.items.join('')
    if (!text) return []
    return [{ kind: op.type === 'equal' ? 'equal' : op.type, text } as WordDiffEntry]
  })
}

/**
 * Compare two documents block by block.
 *
 * Matched on exact normalised text rather than on position, so an untouched
 * paragraph stays untouched however far it travelled.
 */
export function diffBlocks(
  oldBlocks: readonly TextBlock[],
  newBlocks: readonly TextBlock[]
): BlockDiffEntry[] {
  const ops = diffSequences(oldBlocks, newBlocks, (x, y) => x.text === y.text)

  // Walked with a cursor into each side rather than off the op's own items:
  // an equal op carries the blocks from the old document, whose positions are
  // not the positions they now occupy. Reading both tells a reader where a
  // paragraph was *and* where it is, which is the whole point of the view.
  const entries: BlockDiffEntry[] = []
  let oldPosition = 0
  let newPosition = 0
  for (const op of ops) {
    for (const block of op.items) {
      if (op.type === 'equal') {
        entries.push({
          kind: 'unchanged',
          oldIndex: oldBlocks[oldPosition++]?.index ?? null,
          newIndex: newBlocks[newPosition++]?.index ?? null,
          text: block.text
        })
      } else if (op.type === 'delete') {
        entries.push({
          kind: 'removed',
          oldIndex: oldBlocks[oldPosition++]?.index ?? null,
          newIndex: null,
          text: block.text
        })
      } else {
        entries.push({
          kind: 'added',
          oldIndex: null,
          newIndex: newBlocks[newPosition++]?.index ?? null,
          text: block.text
        })
      }
    }
  }

  markMoves(entries)
  markEdits(entries)
  return entries
}

/**
 * A removal whose text turns up again among the additions is a move.
 *
 * Matched nearest-first when the same text appears more than once, so two
 * identical paragraphs that both shifted are paired with the copies they are
 * most plausibly the same as, rather than crossing over each other.
 */
function markMoves(entries: BlockDiffEntry[]): void {
  const additions = new Map<string, number[]>()
  entries.forEach((entry, position) => {
    if (entry.kind !== 'added') return
    const slots = additions.get(entry.text) ?? []
    slots.push(position)
    additions.set(entry.text, slots)
  })

  entries.forEach((entry, position) => {
    if (entry.kind !== 'removed') return
    const slots = additions.get(entry.text)
    if (!slots || slots.length === 0) return
    const nearest = slots.reduce((best, slot) =>
      Math.abs(slot - position) < Math.abs(best - position) ? slot : best
    )
    slots.splice(slots.indexOf(nearest), 1)

    const arrival = entries[nearest]!
    // One row, carrying both ends of the journey; the departure is dropped so a
    // move reads as a move rather than as two half-events. A paragraph that
    // ends up at the index it started from did not go anywhere — the sequence
    // diff can pick an alignment that cuts and re-adds one — so it is reported
    // as untouched rather than as a move to where it already was.
    arrival.kind = arrival.newIndex === entry.oldIndex ? 'unchanged' : 'moved'
    arrival.oldIndex = entry.oldIndex
    entry.kind = 'moved'
    entry.newIndex = arrival.newIndex
    entry.text = ''
  })

  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.kind === 'moved' && entries[i]!.text === '') entries.splice(i, 1)
  }
}

/**
 * A removal and an addition that still resemble each other are one edit.
 *
 * The likeliest candidate wins, and each addition can only be claimed once. Two
 * candidates that resemble the removal equally are separated by distance: an
 * edit happens where the paragraph was, so the nearer one is the better guess.
 */
function markEdits(entries: BlockDiffEntry[]): void {
  const used = new Set<number>()

  entries.forEach((entry, position) => {
    if (entry.kind !== 'removed') return

    let bestSlot = -1
    let bestScore = SAME_PARAGRAPH
    entries.forEach((candidate, slot) => {
      if (candidate.kind !== 'added' || used.has(slot)) return
      const score = similarity(entry.text, candidate.text)
      const closer = bestSlot !== -1 && Math.abs(slot - position) < Math.abs(bestSlot - position)
      if (score > bestScore || (score === bestScore && closer)) {
        bestScore = score
        bestSlot = slot
      }
    })
    if (bestSlot === -1) return

    used.add(bestSlot)
    const after = entries[bestSlot]!
    after.kind = 'changed'
    after.oldIndex = entry.oldIndex
    after.words = diffWords(entry.text, after.text)
    entry.kind = 'changed'
    entry.text = ''
  })

  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.kind === 'changed' && entries[i]!.text === '' && !entries[i]!.words) {
      entries.splice(i, 1)
    }
  }
}

/** Words and the whitespace between them, so a rebuild is exact. */
function splitWords(text: string): string[] {
  return text.match(/\s+|\S+/gu) ?? []
}

function tokenise(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? []
}
