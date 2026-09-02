import { DOC_EXT } from '@shared/constants.js'
import { invoke } from './ipc.js'
import { useDocumentStore } from '@renderer/stores/documentStore.js'
import { useLayoutStore, EDITOR_PANEL_PREFIX } from '@renderer/stores/layoutStore.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'

/**
 * Make sure an opened project puts a page in front of the writer.
 *
 * Runs after the project's layout is restored. A layout that already shows a
 * document wins outright; otherwise the manuscript's first chapter opens, or
 * failing that any document at the project root — and a project with no
 * documents at all gets its first one created. Opening a fresh folder lands in
 * a page ready to type into, not an empty dock with a Welcome tab.
 */
export async function ensureDocumentOpen(): Promise<void> {
  const api = useLayoutStore.getState().api
  const project = useProjectStore.getState().project
  if (!api || !project) return
  if (api.panels.some((panel) => panel.id.startsWith(EDITOR_PANEL_PREFIX))) return

  // The manuscript's own order first: its first chapter is the document the
  // writer most plausibly came back for.
  const view = await invoke('manuscript:view', {}).catch(() => null)
  const inOrder = view?.nodes.find(
    (node) => node.kind === 'document' && !node.missing && node.resolvedPath
  )
  let path = inOrder?.resolvedPath ?? null
  if (!path) {
    const entries = await invoke('vfs:list', { path: '' }).catch(() => null)
    path = entries?.find((entry) => entry.kind === 'file' && entry.name.endsWith(DOC_EXT))?.path ?? null
  }

  const documents = useDocumentStore.getState()
  const docId = path
    ? await documents.openPath(path)
    : // A read-only project (its manifest is from a newer build) must not have
      // files invented into it; it opens to whatever it has, which is nothing.
      project.readOnly
      ? null
      : await documents.create(`untitled${DOC_EXT}`)
  if (!docId) return

  // Something else may have opened a document while the calls above were in
  // flight — a second editor appearing out of nowhere would be worse than the
  // empty dock this exists to prevent.
  const current = useLayoutStore.getState().api
  if (!current || current.panels.some((panel) => panel.id.startsWith(EDITOR_PANEL_PREFIX))) return

  // Focus is only taken from the panels the default layout parks you on. If
  // the person has already opened something themselves — Settings, a board, a
  // dialog over a panel — the page arrives *behind* it: this runs on a delay
  // they cannot see, and work stolen from under someone's hands reads as the
  // app acting up, not as a welcome.
  const activePanel = current.activePanel?.id
  const activate = !activePanel || PASSIVE_PANELS.has(activePanel)

  const state = useDocumentStore.getState().docs[docId]
  if (state) useLayoutStore.getState().openEditor(docId, state.path, state.title, { activate })
}

/** The default layout's own furniture — what a person is looking at only because nothing else is open. */
const PASSIVE_PANELS = new Set(['welcome', 'explorer', 'search'])
