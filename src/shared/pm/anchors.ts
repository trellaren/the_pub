import type { PmDoc, PmMark, PmNode } from '../model/document.js'
import { ANCHOR_MARK } from '../model/anchor.js'
import { extractRawBlocks, forEachTextNode, normalizeBlockText, type RawTextNode } from './extractText.js'

/**
 * One contiguous run of an `anchor` mark within a single block.
 *
 * Coordinates are normalised block-text offsets — the same space
 * `MentionOccurrence` and `SearchHit.ranges` already use — not raw
 * ProseMirror positions. Nothing outside a text walker or mark application
 * ever needs a raw one.
 */
export interface AnchorLocation {
  blockIndex: number
  start: number
  end: number
  /** The normalised text under the mark, for later re-matching if the mark is lost. */
  text: string
}

/**
 * Every place a given `anchorId` currently marks text.
 *
 * A plural result, not a single location: nothing stops a mark from spanning
 * more than one block if it was applied over a multi-paragraph selection, and
 * reporting only the first would silently drop the rest of what a note is
 * attached to.
 */
/**
 * Which mark type and attribute to look for. Defaults to the `anchor` mark's
 * own `anchorId` — every other caller passes this explicitly, naming the mark
 * and attribute it actually reconciles, e.g. `{ markType: 'highlight',
 * attrKey: 'highlightId' }` for Phase 11's collected highlights. Keeping this
 * one walker generic is what "one text-walking implementation" means in
 * practice: a second mark that needs anchor-style recovery reuses it instead
 * of growing its own copy of `forEachTextNode` plus offset bookkeeping.
 */
export interface AnchorMarkConfig {
  markType: string
  attrKey: string
}

const DEFAULT_ANCHOR_MARK_CONFIG: AnchorMarkConfig = { markType: ANCHOR_MARK, attrKey: 'anchorId' }

export function findAnchorLocations(
  doc: PmDoc,
  anchorId: string,
  config: AnchorMarkConfig = DEFAULT_ANCHOR_MARK_CONFIG
): AnchorLocation[] {
  const locations: AnchorLocation[] = []
  for (const block of extractRawBlocks(doc)) {
    const { unmap, text: normalized } = normalizeBlockText(block.text)
    let rawStart: number | null = null
    let rawEnd: number | null = null

    forEachTextNode(block.node, (entry) => {
      const marked = entry.node.marks?.some(
        (mark) => mark.type === config.markType && mark.attrs?.[config.attrKey] === anchorId
      )
      if (!marked) return
      rawStart = rawStart === null ? entry.start : Math.min(rawStart, entry.start)
      rawEnd = rawEnd === null ? entry.end : Math.max(rawEnd, entry.end)
    })

    if (rawStart === null || rawEnd === null) continue
    // `unmap` gives the first surviving normalised offset at or after a raw
    // one, which is exactly the right rule at both ends: applied to `rawStart`
    // it skips past any collapsed whitespace the range starts in, and applied
    // to `rawEnd` it lands one-past the range's last real character rather
    // than short of it.
    const start = unmap[rawStart]!
    const end = unmap[rawEnd]!

    locations.push({ blockIndex: block.index, start, end, text: normalized.slice(start, end) })
  }
  return locations
}

/** The common case: an anchor confined to one block. `null` if it isn't there at all. */
export function findAnchor(
  doc: PmDoc,
  anchorId: string,
  config: AnchorMarkConfig = DEFAULT_ANCHOR_MARK_CONFIG
): AnchorLocation | null {
  return findAnchorLocations(doc, anchorId, config)[0] ?? null
}

/** Every anchor id currently marking text anywhere in the document. */
export function collectAnchorIds(doc: PmDoc): Set<string> {
  const ids = new Set<string>()
  for (const block of extractRawBlocks(doc)) {
    forEachTextNode(block.node, (entry) => {
      for (const mark of entry.node.marks ?? []) {
        if (mark.type !== ANCHOR_MARK) continue
        const id = mark.attrs?.anchorId
        if (typeof id === 'string' && id) ids.add(id)
      }
    })
  }
  return ids
}

/**
 * The text an anchor currently covers, joined across every block it touches.
 *
 * This is what a note stores alongside its `anchorId` so it can find its way
 * back to the prose if the mark itself is ever lost — the same recovery the
 * mention scanner already relies on, searching normalised text rather than a
 * position that a single keystroke upstream would have invalidated.
 */
export function anchorSurfaceText(doc: PmDoc, anchorId: string): string | null {
  const locations = findAnchorLocations(doc, anchorId)
  if (locations.length === 0) return null
  return locations.map((location) => location.text).join(' ')
}

/** A candidate place `anchorText` might still be — not yet a mark, just a place one could go. */
export interface TextOccurrence {
  blockIndex: number
  start: number
  end: number
}

/**
 * Every exact occurrence of `text` in the document, for offering a note whose
 * anchor was lost somewhere to re-attach to.
 *
 * Deliberately the simplest thing that works: an exact, case-sensitive
 * substring match against normalised block text, not a fuzzy one. A note is
 * meant to point at *this* sentence, not at whichever one merely resembles
 * it — and the surrounding UI shows every candidate for a person to pick
 * from, rather than guessing on their behalf.
 */
export function findTextOccurrences(doc: PmDoc, text: string): TextOccurrence[] {
  if (!text) return []
  const occurrences: TextOccurrence[] = []
  for (const block of extractRawBlocks(doc)) {
    const { text: normalized } = normalizeBlockText(block.text)
    let from = 0
    for (;;) {
      const at = normalized.indexOf(text, from)
      if (at === -1) break
      occurrences.push({ blockIndex: block.index, start: at, end: at + text.length })
      from = at + text.length
    }
  }
  return occurrences
}

/**
 * Mark `[start, end)` of a block's normalised text with a fresh `anchorId`.
 *
 * Splices the block's JSON directly rather than computing a live ProseMirror
 * position for the range — the same choice `applyMentionMark` already made,
 * and for the same reason: a normalised text offset only maps cleanly back
 * to a raw one and from there to a PM position when every node between them
 * is plain text. An image or hard break has a PM position size that doesn't
 * match how many characters it contributes to the walker, so anything doing
 * that arithmetic against a document containing one would place the mark in
 * the wrong spot without ever raising an error. Splicing the same JSON the
 * walker already read sidesteps the mismatch instead of working around it.
 *
 * `null` if `blockIndex` doesn't name a real block, or `start`/`end` don't
 * land on a normalised offset that survived the raw round-trip (e.g. inside
 * collapsed whitespace).
 */
export function applyAnchorMark(
  doc: PmDoc,
  blockIndex: number,
  start: number,
  end: number,
  anchorId: string
): PmDoc | null {
  const blocks = extractRawBlocks(doc)
  const block = blocks[blockIndex]
  if (!block || block.index !== blockIndex) return null

  const { map } = normalizeBlockText(block.text)
  const rawStart = map[start]
  const rawEnd = map[end]
  if (rawStart === undefined || rawEnd === undefined || rawStart >= rawEnd) return null

  const content = [...(doc.content ?? [])]
  const clone = structuredClone(content[blockIndex]!) as PmNode

  const targets: RawTextNode[] = []
  forEachTextNode(clone, (entry) => {
    if (entry.node.type !== 'text') return
    if (entry.start < rawEnd && rawStart < entry.end) targets.push(entry)
  })
  if (targets.length === 0) return null

  for (let i = targets.length - 1; i >= 0; i--) {
    const entry = targets[i]!
    const localStart = Math.max(rawStart, entry.start) - entry.start
    const localEnd = Math.min(rawEnd, entry.end) - entry.start
    const pieces = splitAndMarkTextNode(entry.node, localStart, localEnd, anchorId)
    entry.parent.splice(entry.index, 1, ...pieces)
  }

  content[blockIndex] = clone
  return { ...doc, content }
}

function splitAndMarkTextNode(node: PmNode, start: number, end: number, anchorId: string): PmNode[] {
  const text = node.text ?? ''
  const pieces: PmNode[] = []
  const before = text.slice(0, start)
  const inside = text.slice(start, end)
  const after = text.slice(end)
  if (before) pieces.push({ ...node, text: before })
  if (inside) {
    const marks: PmMark[] = [...(node.marks ?? []), { type: ANCHOR_MARK, attrs: { anchorId } }]
    pieces.push({ ...node, text: inside, marks })
  }
  if (after) pieces.push({ ...node, text: after })
  return pieces
}
