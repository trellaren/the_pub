import type { PmDoc, PmMark, PmNode } from '../model/document.js'
import { MENTION_MARK, type MentionAttrs } from '../model/mention.js'
import { forEachTextNode, extractRawBlocks, normalizeBlockText, type RawTextNode } from './extractText.js'
import { findOccurrence } from './mentions.js'

/**
 * Write a `mention` mark over one occurrence of a name, returning a new
 * document — or `null` if the occurrence is no longer there, which is the
 * ordinary outcome when the prose changed after the suggestion was indexed.
 *
 * The occurrence is addressed the way `MentionRef` addresses it: by surface and
 * ordinal in *normalised* block coordinates. Everything raw happens inside this
 * function.
 */
export function applyMentionMark(
  doc: PmDoc,
  blockIndex: number,
  surface: string,
  ordinal: number,
  attrs: MentionAttrs
): PmDoc | null {
  const blocks = extractRawBlocks(doc)
  const block = blocks[blockIndex]
  if (!block || block.index !== blockIndex) return null

  const { text, map } = normalizeBlockText(block.text)
  const start = findOccurrence(text, surface, ordinal)
  if (start === -1) return null

  const rawStart = map[start]
  const rawEnd = map[start + surface.length]
  if (rawStart === undefined || rawEnd === undefined) return null

  const content = [...(doc.content ?? [])]
  // Clone the one block being changed: callers hold the document they passed in
  // (the editor's current value, in the renderer's case) and must not see it
  // mutated underneath them.
  const clone = structuredClone(content[blockIndex]!) as PmNode

  const targets: RawTextNode[] = []
  forEachTextNode(clone, (entry) => {
    if (entry.node.type !== 'text') return
    // A name broken by a bold run spans several text nodes; every one of them
    // needs the mark, or half the name renders unmarked.
    if (entry.start < rawEnd && rawStart < entry.end) targets.push(entry)
  })
  if (targets.length === 0) return null

  // Splice from the end so the earlier entries' recorded indices stay valid.
  for (let i = targets.length - 1; i >= 0; i--) {
    const entry = targets[i]!
    const localStart = Math.max(rawStart, entry.start) - entry.start
    const localEnd = Math.min(rawEnd, entry.end) - entry.start
    const pieces = splitTextNode(entry.node, localStart, localEnd, attrs)
    entry.parent.splice(entry.index, 1, ...pieces)
  }

  content[blockIndex] = clone
  return { ...doc, content }
}

/** Split one text node into up to three, marking only the middle piece. */
function splitTextNode(node: PmNode, start: number, end: number, attrs: MentionAttrs): PmNode[] {
  const text = node.text ?? ''
  const pieces: PmNode[] = []
  const before = text.slice(0, start)
  const inside = text.slice(start, end)
  const after = text.slice(end)

  if (before) pieces.push({ ...node, text: before })
  if (inside) {
    // Replace rather than stack: an occurrence belongs to one record, so a
    // second mention mark here would be ambiguous to every reader of the JSON.
    const marks: PmMark[] = (node.marks ?? []).filter((mark) => mark.type !== MENTION_MARK)
    marks.push({ type: MENTION_MARK, attrs: { ...attrs } })
    pieces.push({ ...node, text: inside, marks })
  }
  if (after) pieces.push({ ...node, text: after })
  return pieces
}
