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

/** Flatten a document into its top-level blocks, preserving their indices. */
export function extractBlocks(doc: PmDoc): TextBlock[] {
  const blocks: TextBlock[] = []
  const content = doc.content ?? []
  for (let index = 0; index < content.length; index++) {
    const node = content[index]!
    blocks.push({ index, type: node.type, text: nodeText(node).replace(/\n+/g, ' ').trim() })
  }
  return blocks
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
