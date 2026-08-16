import type { PmDoc } from '../model/document.js'
import { ANCHOR_MARK } from '../model/anchor.js'
import { extractRawBlocks, forEachTextNode, normalizeBlockText } from './extractText.js'

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
export function findAnchorLocations(doc: PmDoc, anchorId: string): AnchorLocation[] {
  const locations: AnchorLocation[] = []
  for (const block of extractRawBlocks(doc)) {
    const { unmap, text: normalized } = normalizeBlockText(block.text)
    let rawStart: number | null = null
    let rawEnd: number | null = null

    forEachTextNode(block.node, (entry) => {
      const marked = entry.node.marks?.some(
        (mark) => mark.type === ANCHOR_MARK && mark.attrs?.anchorId === anchorId
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
export function findAnchor(doc: PmDoc, anchorId: string): AnchorLocation | null {
  return findAnchorLocations(doc, anchorId)[0] ?? null
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
