import type { Editor } from '@tiptap/core'
import type { Node as PmProseNode } from '@tiptap/pm/model'
import type { StoryEntity } from '@shared/model/entity.js'
import type { MentionHit, MentionAttrs } from '@shared/model/mention.js'
import { MENTION_MARK } from '@shared/model/mention.js'
import type { PmNode } from '@shared/model/document.js'
import { forEachTextNode, normalizeBlockText, rawBlockText } from '@shared/pm/extractText.js'
import { findOccurrence } from '@shared/pm/mentions.js'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'

/**
 * Promote a suggestion into a real mention.
 *
 * Open documents are marked in place. Routing them through the main process
 * would force a `reload()`, and reload calls `setContent`, which throws away
 * that document's undo history — a one-click action must not silently destroy
 * undo. Closed documents, which is the common case for a backlink list, are
 * marked by the main process without opening a tab.
 */
export async function confirmMentionHere(hit: MentionHit, entity: StoryEntity): Promise<boolean> {
  const attrs: MentionAttrs = { entityId: entity.id, entityKind: entity.kind }
  const editor = getEditor(hit.docId)

  if (editor) {
    const marked = markOccurrence(editor, hit.blockIndex, hit.surface, hit.ordinal, attrs)
    if (marked) {
      // Save now rather than waiting out the autosave debounce: the backlink
      // list refetches from the index, which only sees written documents.
      await useDocumentStore.getState().save(hit.docId)
      return true
    }
    return false
  }

  const result = await attempt(
    invoke('mentions:confirm', {
      entityId: entity.id,
      docId: hit.docId,
      blockIndex: hit.blockIndex,
      ordinal: hit.ordinal,
      surface: hit.surface
    }),
    'Could not confirm the mention'
  )
  return result?.ok === true
}

/**
 * Add the mention mark over one occurrence, in a single transaction.
 *
 * Offsets arrive in normalised block coordinates. Translating them to
 * ProseMirror positions without writing a second text walker is the point of
 * the pairing below: the JSON walker and ProseMirror's own traversal visit the
 * same leaves in the same order, so the k-th of one is the k-th of the other.
 */
export function markOccurrence(
  editor: Editor,
  blockIndex: number,
  surface: string,
  ordinal: number,
  attrs: MentionAttrs
): boolean {
  const markType = editor.schema.marks[MENTION_MARK]
  if (!markType) return false

  const block = editor.state.doc.child(blockIndex) as PmProseNode | undefined
  if (!block) return false

  // Absolute position of the block's first child.
  let blockStart = 0
  for (let i = 0; i < blockIndex; i++) blockStart += editor.state.doc.child(i).nodeSize
  const contentStart = blockStart + 1

  const leaves: { pos: number }[] = []
  block.descendants((node, pos) => {
    if (node.isText || node.type.name === 'hardBreak') leaves.push({ pos: contentStart + pos })
    return true
  })

  const json = block.toJSON() as PmNode
  const entries: { start: number; end: number; isText: boolean }[] = []
  forEachTextNode(json, (entry) => {
    entries.push({ start: entry.start, end: entry.end, isText: entry.node.type === 'text' })
  })
  // The two traversals must have seen the same leaves, or the pairing below is
  // meaningless and it is safer to decline than to mark the wrong words.
  if (entries.length !== leaves.length) return false

  const { text, map } = normalizeBlockText(rawBlockText(json))
  const start = findOccurrence(text, surface, ordinal)
  if (start === -1) return false
  const rawStart = map[start]
  const rawEnd = map[start + surface.length]
  if (rawStart === undefined || rawEnd === undefined) return false

  const transaction = editor.state.tr
  let marked = false
  for (const [index, entry] of entries.entries()) {
    if (!entry.isText) continue
    if (entry.end <= rawStart || rawEnd <= entry.start) continue
    const leaf = leaves[index]!
    const from = leaf.pos + Math.max(rawStart, entry.start) - entry.start
    const to = leaf.pos + Math.min(rawEnd, entry.end) - entry.start
    transaction.addMark(from, to, markType.create({ ...attrs }))
    marked = true
  }
  if (!marked) return false

  editor.view.dispatch(transaction)
  return true
}
