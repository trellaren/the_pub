import { create } from 'zustand'
import type { Highlight } from '@shared/model/highlight.js'
import { NOTE_SAVE_DEBOUNCE_MS } from '@shared/constants.js'
import { invoke, attempt, on } from '@renderer/lib/ipc.js'

interface HighlightStore {
  highlightsByDoc: Record<string, Highlight[]>
  loadForDoc: (docId: string) => Promise<void>
  collect: (
    docId: string,
    highlightId: string,
    fields: { color: string; quote: string; blockIndex: number; categoryId?: string }
  ) => Promise<Highlight | null>
  /** Optimistic edit; the write is debounced behind it. */
  patch: (docId: string, id: string, changes: Partial<Highlight>) => void
  remove: (docId: string, id: string) => Promise<void>
  /** Write every pending edit now. Called before the window closes. */
  flush: () => Promise<void>
}

/** Debounce timers keyed by `docId:id`, same reasoning as `noteStore`'s. */
const pending = new Map<string, ReturnType<typeof setTimeout>>()

function keyFor(docId: string, id: string): string {
  return `${docId} ${id}`
}

async function saveNow(docId: string, id: string): Promise<void> {
  const highlight = useHighlightStore.getState().highlightsByDoc[docId]?.find((candidate) => candidate.id === id)
  if (!highlight) return
  const saved = await attempt(invoke('highlights:save', { docId, highlight }), 'Could not save highlight')
  if (!saved) return
  const current = useHighlightStore.getState().highlightsByDoc[docId] ?? []
  useHighlightStore.setState({
    highlightsByDoc: {
      ...useHighlightStore.getState().highlightsByDoc,
      [docId]: current.map((candidate) => (candidate.id === saved.id ? saved : candidate))
    }
  })
}

export const useHighlightStore = create<HighlightStore>((set, get) => ({
  highlightsByDoc: {},

  loadForDoc: async (docId) => {
    const highlights = await attempt(invoke('highlights:list', { docId }), 'Could not load highlights')
    if (!highlights) return
    set({ highlightsByDoc: { ...get().highlightsByDoc, [docId]: highlights } })
  },

  collect: async (docId, highlightId, fields) => {
    const collected = await attempt(
      invoke('highlights:collect', { docId, highlightId, ...fields }),
      'Could not collect highlight'
    )
    if (!collected) return null
    const current = get().highlightsByDoc[docId] ?? []
    const next = current.some((candidate) => candidate.highlightId === highlightId)
      ? current.map((candidate) => (candidate.highlightId === highlightId ? collected : candidate))
      : [...current, collected]
    set({ highlightsByDoc: { ...get().highlightsByDoc, [docId]: next } })
    return collected
  },

  patch: (docId, id, changes) => {
    const current = get().highlightsByDoc[docId] ?? []
    const next = current.map((highlight) => (highlight.id === id ? { ...highlight, ...changes } : highlight))
    set({ highlightsByDoc: { ...get().highlightsByDoc, [docId]: next } })

    const key = keyFor(docId, id)
    const existing = pending.get(key)
    if (existing) clearTimeout(existing)
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key)
        void saveNow(docId, id)
      }, NOTE_SAVE_DEBOUNCE_MS)
    )
  },

  remove: async (docId, id) => {
    const key = keyFor(docId, id)
    const timer = pending.get(key)
    if (timer) clearTimeout(timer)
    pending.delete(key)
    await attempt(invoke('highlights:delete', { docId, id }), 'Could not delete highlight')
    set({
      highlightsByDoc: {
        ...get().highlightsByDoc,
        [docId]: (get().highlightsByDoc[docId] ?? []).filter((highlight) => highlight.id !== id)
      }
    })
  },

  flush: async () => {
    const keys = [...pending.keys()]
    for (const key of keys) {
      const timer = pending.get(key)
      if (timer) clearTimeout(timer)
      pending.delete(key)
      const [docId, id] = key.split(' ') as [string, string]
      await saveNow(docId, id)
    }
  }
}))

// A document's own save can reconcile highlights (orphaning one, refreshing
// another's quote) without the renderer ever calling a highlights endpoint —
// this is how that reaches whichever panel is showing them.
on('highlights:changed', ({ docId }) => {
  void useHighlightStore.getState().loadForDoc(docId)
})
