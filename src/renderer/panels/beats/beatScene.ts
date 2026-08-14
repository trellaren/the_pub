import type { Beat } from '@shared/model/beat.js'
import { invoke } from '@renderer/lib/ipc.js'
import { openLocation } from '@renderer/lib/openLocation.js'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'

/**
 * Open the scene a beat points at.
 *
 * A beat stores a `docId`, not a path, for the same reason a dock panel does:
 * moving a chapter in Finder must not break the board. The path is resolved
 * through the index at the moment of opening.
 */
export async function openBeatScene(beat: Beat): Promise<boolean> {
  if (!beat.docId) return false
  const resolved = await invoke('doc:resolve', { docId: beat.docId }).catch(() => null)
  if (!resolved) return false
  return openLocation({
    path: resolved.path,
    title: beat.title,
    blockIndex: beat.blockIndex ?? 0
  })
}

/**
 * Where the caret is right now: the document and the paragraph within it.
 *
 * This is what "link this beat to what I'm looking at" means, and reading it
 * from the editor's own selection is the only way to get the paragraph — the
 * store tracks documents, not cursors.
 */
export function currentSceneLocation(): { docId: string; blockIndex: number } | null {
  const docId = useDocumentStore.getState().activeDocId
  if (!docId) return null
  const editor = getEditor(docId)
  if (!editor) return null
  // Depth 0 is the document, so index(0) is the top-level block the caret is in
  // — the same coordinate the search index and mentions use.
  const blockIndex = editor.state.selection.$from.index(0)
  return { docId, blockIndex }
}
