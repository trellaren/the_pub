import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { ulid } from 'ulid'
import { BLOCK_ID_TYPES } from '@shared/pm/blockIds.js'

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
          if (!transactions.some((transaction) => transaction.docChanged)) return null

          const seen = new Set<string>()
          let tr: Transaction | null = null
          newState.doc.descendants((node, pos) => {
            if (!BLOCK_ID_TYPES.has(node.type.name)) return
            const id = node.attrs.blockId as string | null
            if (!id) return
            if (seen.has(id)) {
              let freshId = ulid()
              while (seen.has(freshId)) freshId = ulid()
              seen.add(freshId)
              tr ??= newState.tr
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: freshId })
            } else {
              seen.add(id)
            }
          })
          return tr
        }
      })
    ]
  }
})
