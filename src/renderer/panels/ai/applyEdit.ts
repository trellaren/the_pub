import type { AssistantEdit } from '@shared/pm/assistantEdits.js'
import { applyAssistantEdit } from '@shared/pm/assistantEdits.js'
import type { PmDoc } from '@shared/model/document.js'
import { invoke } from '@renderer/lib/ipc.js'
import { getEditor } from '@renderer/stores/documentStore.js'
import { replaceDocument } from '../editor/editorActions.js'

export type EditOutcome =
  | { ok: true; where: 'editor' | 'disk'; failed: number }
  | { ok: false; reason: 'missing' | 'conflict' | 'format-too-new' | 'no-match' }

/**
 * Land an assistant edit wherever the document currently lives.
 *
 * Open in an editor: applied to the editor's own JSON and dispatched as one
 * transaction, so it joins the undo stack and the ordinary autosave writes it.
 * Not open: main applies the same function to the file. Both paths run
 * `applyAssistantEdit`, which is what keeps "what a suggestion does" from
 * depending on whether a tab happened to be open.
 */
export async function applyAssistantEditLocally(edit: AssistantEdit): Promise<EditOutcome> {
  const editor = getEditor(edit.docId)
  if (editor) {
    const applied = applyAssistantEdit(editor.getJSON() as PmDoc, edit)
    if (applied.failed.length === edit.ops.length) return { ok: false, reason: 'no-match' }
    replaceDocument(editor, applied.doc)
    return { ok: true, where: 'editor', failed: applied.failed.length }
  }

  const result = await invoke('ai:applyEdit', { edit })
  if (!result.ok) return result
  return { ok: true, where: 'disk', failed: result.failed.length }
}
