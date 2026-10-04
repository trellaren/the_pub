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

/** Forget per-document state that belongs to the project being left. */
export function resetDocumentScopedStores(): void {
  useHighlightStore.setState(useHighlightStore.getInitialState(), true)
  useNoteStore.setState(useNoteStore.getInitialState(), true)
  useHistoryStore.setState(useHistoryStore.getInitialState(), true)
  useResearchStore.setState(useResearchStore.getInitialState(), true)
  // Who we are and whether we are suggesting are this person's, not the project's.
  useReviewStore.setState({ threadsByDoc: {}, authors: [], presence: [] })
}
