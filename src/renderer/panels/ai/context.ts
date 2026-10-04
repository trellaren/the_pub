import type { ToolCall } from '@shared/model/ai.js'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'

const DOCUMENT_TOOLS = new Set(['suggest_edit', 'comment', 'reply_comment', 'proofread', 'read_document'])

export function documentPathOf(call: ToolCall): string | null {
  if (!DOCUMENT_TOOLS.has(call.name)) return null
  try {
    const args = JSON.parse(call.args || '{}') as { path?: unknown }
    return typeof args.path === 'string' && args.path ? args.path : null
  } catch {
    return null
  }
}

export function hasEditorSelection(docId: string | null): boolean {
  const editor = docId ? getEditor(docId) : undefined
  return Boolean(editor && editor.state.selection.from !== editor.state.selection.to)
}

/**
 * What to send with the question: the selected prose, or the whole open
 * document when nothing is selected.
 */
export function manuscriptContext(): string {
  const docId = useDocumentStore.getState().activeDocId
  if (!docId) return ''
  const editor = getEditor(docId)
  if (!editor) return ''
  const { from, to } = editor.state.selection
  if (from !== to) return editor.state.doc.textBetween(from, to, '\n\n')
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n\n')
}

/** The file name of a sideloaded model, on either platform's separator. */
export function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}
