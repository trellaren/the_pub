import { useProjectStore } from './projectStore.js'
import { useDocumentStore } from './documentStore.js'
import { useLayoutStore, restoreLayout } from './layoutStore.js'
import { resetProjectScopedStores } from './pendingWrites.js'

/**
 * Back to Welcome with nothing open, after main's session has already gone —
 * by an explicit close, or by a failed reopen of the same project.
 */
export async function resetToNoProject(): Promise<void> {
  useProjectStore.setState({ project: null })
  const api = useLayoutStore.getState().api
  if (api) {
    // Clearing and re-adding a panel id in one tick lets the old panel's
    // overlay teardown land on the new one, leaving Welcome hidden; rebuild a
    // frame after the clear instead.
    api.clear()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    restoreLayout(api, null)
  }
  useDocumentStore.getState().discardAll()
  resetProjectScopedStores()
}
