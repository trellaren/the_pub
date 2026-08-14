import type { PmDoc, PmNode } from '../model/document.js'

export interface TextBlock {
  /** Position in the document's top-level content array — the jump-to target. */
  index: number
  type: string
  text: string
}

/** Node types whose children are inline and must be joined without separators. */
const INLINE_TYPES = new Set(['text', 'hardBreak', 'image', 'characterMention', 'mention'])

function isInline(node: PmNode): boolean {
  return INLINE_TYPES.has(node.type)
}

function nodeText(node: PmNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  const children = node.content
  if (!children || children.length === 0) return ''
  // A textblock's children are all inline, so they concatenate directly. Anything
  // else (lists, blockquotes, tables) holds block children that need separating.
  // Deciding from the children themselves avoids hard-coding the editor schema.
  const separator = children.every(isInline) ? '' : '\n'
  return children.map(nodeText).join(separator)
}

/**
 * One text-bearing leaf inside a block, with where its characters landed in the
 * block's *raw* text.
 *
 * `parent`/`index` are the node's slot in its containing content array, which is
 * what lets a caller replace it in place — splitting a text node to apply a mark
 * over part of it.
 */
export interface RawTextNode {
  node: PmNode
  text: string
  /** Offsets within the block's raw text. */
  start: number
  end: number
  parent: PmNode[]
  index: number
}

/**
 * Visit every text-bearing leaf of `node` in document order, tracking raw
 * offsets.
 *
 * This mirrors `nodeText` exactly — same inline test, same separators — so that
 * `rawText.slice(entry.start, entry.end) === entry.text` holds for every entry.
 * That equality is the whole point of the module: mention offsets, block text,
 * FTS snippets and mark application all have to agree about where a character
 * is, and they only can if one walker produces all of them.
 */
export function forEachTextNode(node: PmNode, visit: (entry: RawTextNode) => void): void {
  walk(node, 0, visit, EMPTY_PARENT, 0)
}

const EMPTY_PARENT: PmNode[] = []

function walk(
  node: PmNode,
  offset: number,
  visit: (entry: RawTextNode) => void,
  parent: PmNode[],
  index: number
): number {
  if (node.type === 'text') {
    const text = node.text ?? ''
    visit({ node, text, start: offset, end: offset + text.length, parent, index })
    return offset + text.length
  }
  if (node.type === 'hardBreak') {
    visit({ node, text: '\n', start: offset, end: offset + 1, parent, index })
    return offset + 1
  }
  const children = node.content
  if (!children || children.length === 0) return offset
  const separatorLength = children.every(isInline) ? 0 : 1
  let cursor = offset
  for (let i = 0; i < children.length; i++) {
    if (i > 0) cursor += separatorLength
    cursor = walk(children[i]!, cursor, visit, children, i)
  }
  return cursor
}

/** A top-level block with its text *before* normalisation. */
export interface RawBlock {
  index: number
  type: string
  /** Newlines and surrounding whitespace still present. */
  text: string
  node: PmNode
}

export function extractRawBlocks(doc: PmDoc): RawBlock[] {
  const content = doc.content ?? []
  const blocks: RawBlock[] = []
  for (let index = 0; index < content.length; index++) {
    const node = content[index]!
    blocks.push({ index, type: node.type, text: nodeText(node), node })
  }
  return blocks
}

/**
 * The result of normalising one block's raw text, with the offset maps needed
 * to translate in both directions.
 */
export interface BlockTextMap {
  /** Normalised text: `raw.replace(/\n+/g, ' ').trim()`. */
  text: string
  /** Normalised offset → raw offset. Length is `text.length + 1`. */
  map: Int32Array
  /** Raw offset → normalised offset. Length is `raw.length + 1`. */
  unmap: Int32Array
}

/**
 * Collapse newline runs to single spaces and trim, recording where every
 * surviving character came from.
 *
 * This is the *only* implementation of that normalisation. A second one written
 * beside it would drift silently — and only for documents containing hard
 * breaks, lists or leading whitespace, which is the worst possible failure
 * profile: the database, the snippets and the mark-writing code would each
 * believe a mention sits somewhere slightly different.
 */
export function normalizeBlockText(raw: string): BlockTextMap {
  let collapsed = ''
  const srcStart: number[] = []
  const srcEnd: number[] = []

  for (let r = 0; r < raw.length; ) {
    if (raw[r] === '\n') {
      let run = r
      while (run < raw.length && raw[run] === '\n') run++
      // A whole run becomes one space, so it has one source range, not many.
      collapsed += ' '
      srcStart.push(r)
      srcEnd.push(run)
      r = run
    } else {
      collapsed += raw[r]
      srcStart.push(r)
      srcEnd.push(r + 1)
      r++
    }
  }

  // Use the real `trim()` rather than a hand-rolled whitespace test, so the
  // result is identical to the expression this replaces by construction.
  const lead = collapsed.length - collapsed.trimStart().length
  const text = collapsed.trim()
  const n = text.length

  const map = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) map[i] = srcStart[lead + i]!
  map[n] = n > 0 ? srcEnd[lead + n - 1]! : 0

  // unmap[r] = the first normalised offset at or after raw offset r. Raw
  // characters that were collapsed or trimmed away therefore resolve forward to
  // the next surviving character.
  const unmap = new Int32Array(raw.length + 1)
  let i = 0
  for (let r = 0; r <= raw.length; r++) {
    while (i < n && map[i]! < r) i++
    unmap[r] = i
  }

  return { text, map, unmap }
}

/** Flatten a document into its top-level blocks, preserving their indices. */
export function extractBlocks(doc: PmDoc): TextBlock[] {
  return extractRawBlocks(doc).map((block) => ({
    index: block.index,
    type: block.type,
    text: normalizeBlockText(block.text).text
  }))
}

export function extractPlainText(doc: PmDoc): string {
  return (doc.content ?? []).map(nodeText).join('\n')
}

export function countWords(doc: PmDoc | string): number {
  const text = typeof doc === 'string' ? doc : extractPlainText(doc)
  const matches = text.match(/[\p{L}\p{N}'’-]+/gu)
  return matches ? matches.length : 0
}

/** First non-empty block's text, used to title untitled documents. */
export function firstLine(doc: PmDoc, max = 80): string {
  for (const block of extractBlocks(doc)) {
    if (block.text) return block.text.slice(0, max)
  }
  return ''
}
