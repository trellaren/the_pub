import { useDocumentStore } from './documentStore.js'
import { useEntityStore } from './entityStore.js'
import { useBeatStore } from './beatStore.js'
import { useMapStore } from './mapStore.js'
import { useSourceStore } from './sourceStore.js'
import { useHighlightStore } from './highlightStore.js'
import { useStatsStore } from './statsStore.js'
import { useNoteStore } from './noteStore.js'
import { useHistoryStore } from './historyStore.js'
import { useResearchStore } from './researchStore.js'
import { useReviewStore } from './reviewStore.js'
import { useChatStore } from './chatStore.js'

/**
 * Write every debounced edit now. One list for both callers — closing the
 * window and switching project — because a store missing from a hand-kept
 * copy of it is exactly how margin notes came to be lost on close.
 */
export async function flushPendingWrites(): Promise<void> {
  await Promise.allSettled([
    useDocumentStore.getState().flushAll(),
    useEntityStore.getState().flush(),
    useBeatStore.getState().flush(),
    useMapStore.getState().flush(),
    useSourceStore.getState().flush(),
    useHighlightStore.getState().flush(),
    useStatsStore.getState().flush(),
    useNoteStore.getState().flush()
  ])
}

/**
 * Forget everything that belongs to the project being left — records, chats,
 * stats and the per-document stores alike. One list for closing and for
 * switching, for the same reason `flushPendingWrites` is one list: a store
 * missing from a hand-kept copy shows the last project's data in the next.
 *
 * Open documents are not here: their editors need tearing down, which
 * `documentStore.discardAll` does on close, and a switch replaces the layout
 * that holds them.
 */
export function resetProjectScopedStores(): void {
  resetDocumentScopedStores()
  useEntityStore.setState(useEntityStore.getInitialState(), true)
  useBeatStore.setState(useBeatStore.getInitialState(), true)
  useMapStore.setState(useMapStore.getInitialState(), true)
  useSourceStore.setState(useSourceStore.getInitialState(), true)
  useStatsStore.setState({ days: [] })
  // Keys and downloaded models belong to this machine, not the project; their
  // errors are cleared so a failure in the old project doesn't greet the new one.
  useChatStore.setState({
    chats: [],
    settings: null,
    activeChatId: null,
    streaming: null,
    loaded: false,
    retrieval: null,
    retrievalError: null,
    keysError: null,
    llmError: null
  })
}

/** Forget per-document state that belongs to the project being left. */
function resetDocumentScopedStores(): void {
  useHighlightStore.setState(useHighlightStore.getInitialState(), true)
  useNoteStore.setState(useNoteStore.getInitialState(), true)
  useHistoryStore.setState(useHistoryStore.getInitialState(), true)
  useResearchStore.setState(useResearchStore.getInitialState(), true)
  // Who we are and whether we are suggesting are this person's, not the project's.
  useReviewStore.setState({ threadsByDoc: {}, authors: [], presence: [] })
}
