import type { PmDoc, PmNode } from '../model/document.js'
import type { NamedStyle } from '../model/style.js'
import { resolveStyle } from '../model/style.js'
import { rawBlockText, normalizeBlockText } from './extractText.js'

/** One heading-level block, in document order. */
export interface TocEntry {
  blockIndex: number
  /** `null` when the block has never been referenced and so has no id yet. */
  blockId: string | null
  text: string
  level: number
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
  const entries: TocEntry[] = []
  for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
    const node = content[blockIndex]!
    const level = outlineLevelOf(node, styles)
    if (level === null) continue
    const text = normalizeBlockText(rawBlockText(node)).text
    if (!text) continue
    const blockId = typeof node.attrs?.blockId === 'string' ? node.attrs.blockId : null
    entries.push({ blockIndex, blockId, text, level })
  }
  return entries
}

/**
 * Deliberately not `defaultStyleFor` from `namedStyles.ts`: that lives in a
 * renderer TipTap extension, and this module has to stay usable from plain
 * JSON with no TipTap or DOM in reach. The fallback it needs is much narrower
 * anyway — only "no style, but it's a heading node" — the rest is a direct
 * `resolveStyle` lookup.
 */
function outlineLevelOf(node: PmNode, styles: NamedStyle[]): number | null {
  const styleId = typeof node.attrs?.styleId === 'string' ? node.attrs.styleId : null
  if (styleId) {
    const resolved = resolveStyle(styleId, styles)
    const level = resolved?.outlineLevel ?? resolved?.headingLevel
    if (level !== undefined) return level
  }
  if (node.type === 'heading') {
    const level = node.attrs?.level
    if (typeof level === 'number') return level
  }
  return null
}
