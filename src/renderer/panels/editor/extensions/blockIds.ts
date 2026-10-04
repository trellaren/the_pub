import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { Node as PmNode } from '@tiptap/pm/model'
import { ulid } from 'ulid'
import { BLOCK_ID_TYPES } from '@shared/pm/blockIds.js'
import { forEachStepRange } from './stepRanges.js'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockIds: {
      /** Low-level only — nothing calls this yet. Cross-references and bookmarks will. */
      setBlockId: (pos: number, id: string) => ReturnType
    }
  }
}

const blockIdsPluginKey = new PluginKey('blockIds')

/**
 * Stable identity for a block, independent of its position in the document.
 *
 * Nothing reads a `blockId` yet — that starts with cross-references and
 * tables of contents — so this extension ships only the mechanism: the
 * attribute itself, and the safety net that stops one surviving a paste.
 *
 * The dedup logic here is deliberately not a call into
 * `shared/pm/blockIds.ts`'s `dedupeBlockIds`: that function works on plain
 * JSON for load-time sanitising, while a live transaction has to mutate real
 * ProseMirror positions to keep selection and undo history intact. Same rule,
 * two implementations, for the same reason `applyMentionMark` and `Mention`'s
 * own `setMention` command are not one function either.
 */
export const BlockIds = Extension.create({
  name: 'blockIds',

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_ID_TYPES],
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-block-id'),
            renderHTML: (attributes) =>
              attributes.blockId ? { 'data-block-id': attributes.blockId } : {}
          }
        }
      }
    ]
  },

  addCommands() {
    return {
      setBlockId:
        (pos, id) =>
        ({ tr, dispatch }) => {
          const node = tr.doc.nodeAt(pos)
          if (!node || !BLOCK_ID_TYPES.has(node.type.name)) return false
          if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: id })
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockIdsPluginKey,
        appendTransaction: (transactions, _oldState, newState): Transaction | null => {
          if (!transactions.some(mayDuplicateBlockId)) return null
          return dedupeLiveBlockIds(newState)
        }
      })
    ]
  }
})

function idCounts(doc: PmNode, from: number, to: number, counts: Map<string, number>, sign: 1 | -1): void {
  doc.nodesBetween(from, Math.min(to, doc.content.size), (node) => {
    if (!BLOCK_ID_TYPES.has(node.type.name)) return
    const id = node.attrs.blockId as string | null
    if (id) counts.set(id, (counts.get(id) ?? 0) + sign)
  })
}

/**
 * A duplicate can only appear where some step made an id more common than it
 * was — a split that copies the attribute, a paste, a `setBlockId`. Comparing
 * the blocks each step touched, before against after, finds that without
 * walking the whole document on every keystroke; the full dedupe pass runs
 * only when it is actually needed.
 */
export function mayDuplicateBlockId(transaction: Transaction): boolean {
  if (!transaction.docChanged) return false
  const counts = new Map<string, number>()
  forEachStepRange(transaction, (range) => {
    idCounts(range.before, range.from, range.to, counts, -1)
    idCounts(range.after, range.afterFrom, range.afterTo, counts, 1)
  })
  for (const delta of counts.values()) if (delta > 0) return true
  return false
}

export function dedupeLiveBlockIds(state: EditorState): Transaction | null {
  const seen = new Set<string>()
  let tr: Transaction | null = null
  state.doc.descendants((node, pos) => {
    if (!BLOCK_ID_TYPES.has(node.type.name)) return
    const id = node.attrs.blockId as string | null
    if (!id) return
    if (seen.has(id)) {
      let freshId = ulid()
      while (seen.has(freshId)) freshId = ulid()
      seen.add(freshId)
      tr ??= state.tr
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: freshId })
    } else {
      seen.add(id)
    }
  })
  return tr
}
