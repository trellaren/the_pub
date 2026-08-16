import type { Editor } from '@tiptap/core'
import { ulid } from 'ulid'
import type { PmDoc } from '@shared/model/document.js'
import type { NamedStyle } from '@shared/model/style.js'
import { buildToc, tocEntryLabel, type TocEntry } from '@shared/pm/toc.js'
import { findFieldRunRange } from '@shared/pm/fieldRuns.js'
import { FIELD_NODE } from '@shared/model/field.js'

/**
 * Assign a `blockId` to every outline-eligible block that doesn't have one
 * yet, in one transaction.
 *
 * A field points at a `blockId`, not a position — positions move on every
 * keystroke anywhere earlier in the document, which is exactly why `Anchors`
 * and blocks both exist — and most headings have never had one minted, since
 * nothing has pointed at them before now.
 */
function ensureHeadingBlockIds(editor: Editor, styles: NamedStyle[]): void {
  const entries = buildToc(editor.getJSON() as PmDoc, styles)
  const missingIndexes = new Set(entries.filter((entry) => !entry.blockId).map((entry) => entry.blockIndex))
  if (missingIndexes.size === 0) return

  const { state, view } = editor
  const tr = state.tr
  state.doc.forEach((node, offset, index) => {
    if (!missingIndexes.has(index)) return
    tr.setNodeMarkup(offset, undefined, { ...node.attrs, blockId: ulid() })
  })
  view.dispatch(tr)
}

/** Every heading currently in the document, with a `blockId` guaranteed on each. */
export function headingEntries(editor: Editor, styles: NamedStyle[]): TocEntry[] {
  ensureHeadingBlockIds(editor, styles)
  return buildToc(editor.getJSON() as PmDoc, styles)
}

/** Insert a cross-reference to `entry` at the current selection. */
export function insertCrossReference(editor: Editor, entry: TocEntry): void {
  editor
    .chain()
    .focus()
    .insertField({ kind: 'ref', targetBlockId: entry.blockId, level: entry.level }, tocEntryLabel(entry))
    .run()
}


/**
 * The PM position range covering top-level child indexes `[start, end)`.
 *
 * `to` defaults to the end of the document: `forEach` only visits indexes up
 * to `childCount - 1`, so a range that runs to the last block never gets an
 * explicit match for `index === end` and needs the fallback.
 */
export function positionsOf(editor: Editor, start: number, end: number): { from: number; to: number } {
  let from = 0
  let to = editor.state.doc.content.size
  editor.state.doc.forEach((_node, offset, index) => {
    if (index === start) from = offset
    if (index === end) to = offset
  })
  return { from, to }
}

/**
 * Create a table of contents, or bring an existing one up to date.
 *
 * Idempotent by design — one command handles both "insert" and "refresh",
 * because distinguishing them from the toolbar would mean either exposing two
 * buttons for what is conceptually one action, or asking the command to guess
 * intent. It finds any table of contents already in the document (a
 * contiguous run of paragraphs each holding exactly one `toc` field) and
 * replaces it in place; with none found, it inserts a fresh one at the top.
 */
export function insertOrRefreshTableOfContents(editor: Editor, styles: NamedStyle[]): void {
  const entries = headingEntries(editor, styles)
  const content = entries.map((entry) => {
    const label = tocEntryLabel(entry)
    return {
      type: 'paragraph',
      content: [
        {
          type: FIELD_NODE,
          attrs: { kind: 'toc', targetBlockId: entry.blockId, level: entry.level },
          content: label ? [{ type: 'text', text: label }] : []
        }
      ]
    }
  })
  // A table of contents with nothing to list yet still needs a placeholder
  // paragraph — inserting an empty array is a no-op, which would silently
  // fail to create the block a person just asked for.
  const body = content.length > 0 ? content : [{ type: 'paragraph', content: [] }]

  const existing = findFieldRunRange(editor.getJSON() as PmDoc, 'toc')
  if (existing) {
    const { from, to } = positionsOf(editor, existing.start, existing.end)
    editor.chain().focus().insertContentAt({ from, to }, body).run()
  } else {
    editor.chain().focus().insertContentAt(0, body).run()
  }
}
