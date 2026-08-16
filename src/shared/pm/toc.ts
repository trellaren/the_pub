import type { PmDoc } from '../model/document.js'
import type { NamedStyle } from '../model/style.js'
import { rawBlockText, normalizeBlockText } from './extractText.js'
import { computeHeadingNumbers, outlineLevelOf } from './headingNumbers.js'

/** One heading-level block, in document order. */
export interface TocEntry {
  blockIndex: number
  /** `null` when the block has never been referenced and so has no id yet. */
  blockId: string | null
  text: string
  level: number
  /** "1.2.3", when the block's outline level has numbering configured. */
  number?: string
}

/**
 * Every top-level block that belongs in a table of contents, in document
 * order.
 *
 * A block qualifies by its *resolved* style's `outlineLevel` — falling back to
 * `headingLevel` when a style leaves it unset, so every built-in heading style
 * is already "in the contents" without a project having to configure
 * anything. Purely a read: it does not mint the `blockId`s the caller will
 * need to actually link to these blocks, the same way `dedupeBlockIds` leaves
 * id-minting to its live counterpart — this only has to agree with whatever
 * ids already exist.
 */
export function buildToc(doc: PmDoc, styles: NamedStyle[]): TocEntry[] {
  const content = doc.content ?? []
  const numbers = computeHeadingNumbers(doc, styles)
  const entries: TocEntry[] = []
  for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
    const node = content[blockIndex]!
    const level = outlineLevelOf(node, styles)
    if (level === null) continue
    const text = normalizeBlockText(rawBlockText(node)).text
    if (!text) continue
    const blockId = typeof node.attrs?.blockId === 'string' ? node.attrs.blockId : null
    const number = numbers.get(blockIndex)
    entries.push(number ? { blockIndex, blockId, text, level, number } : { blockIndex, blockId, text, level })
  }
  return entries
}
