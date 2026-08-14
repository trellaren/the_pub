import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import { useLayoutStore } from '@renderer/stores/layoutStore.js'
import { revealBlock } from '@renderer/panels/editor/editorActions.js'

export interface DocumentLocation {
  path: string
  title: string
  blockIndex: number
  /** Text to highlight once the block is on screen. */
  term?: string
}

/**
 * Open a document and scroll to one of its paragraphs.
 *
 * Shared by search hits and mention backlinks. The imperative reads are load
 * bearing: `openPath` may have *just* created this document's entry, so the
 * hook values captured in this tick are stale and the store has to be read
 * again after the await.
 */
export async function openLocation(location: DocumentLocation): Promise<boolean> {
  const docId = await useDocumentStore.getState().openPath(location.path)
  if (!docId) return false

  const state = useDocumentStore.getState().docs[docId]
  useLayoutStore.getState().openEditor(docId, location.path, state?.title ?? location.title)

  // The editor may have only just been created; let it mount before scrolling.
  requestAnimationFrame(() => {
    const editor = getEditor(docId)
    if (editor) revealBlock(editor, location.blockIndex, location.term)
  })
  return true
}
