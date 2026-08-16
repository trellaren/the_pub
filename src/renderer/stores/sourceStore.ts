import { create } from 'zustand'
import type { CslItem } from '@shared/model/source.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'

interface SourceStore {
  sources: CslItem[]
  loaded: boolean
  /** Bumped on every load/create/patch/remove — a signal, not a value, for anything that must recompute when the library changes. */
  revision: number
  load: () => Promise<void>
  create: (type: string) => Promise<CslItem | null>
  /** Optimistic edit; the write is debounced behind it, the same shape `entityStore.patch` uses. */
  patch: (id: string, changes: Partial<CslItem>) => void
  remove: (id: string) => Promise<void>
  /** Write any pending edit now. Called before the window closes. */
  flush: () => Promise<void>
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()
const SOURCE_SAVE_DEBOUNCE_MS = 600

export const useSourceStore = create<SourceStore>((set, get) => ({
  sources: [],
  loaded: false,
  revision: 0,

  load: async () => {
    const file = await attempt(invoke('sources:list', {}), 'Could not load sources')
    if (!file) return
    set({ sources: file.sources, loaded: true, revision: get().revision + 1 })
  },

  create: async (type) => {
    const source = await attempt(invoke('sources:create', { type }), 'Could not add a source')
    if (!source) return null
    set({ sources: [...get().sources, source], revision: get().revision + 1 })
    return source
  },

  patch: (id, changes) => {
    set({
      sources: get().sources.map((source) => (source.id === id ? { ...source, ...changes } : source)),
      revision: get().revision + 1
    })
    const existing = pending.get(id)
    if (existing) clearTimeout(existing)
    pending.set(
      id,
      setTimeout(() => {
        pending.delete(id)
        void saveNow(id)
      }, SOURCE_SAVE_DEBOUNCE_MS)
    )
  },

  remove: async (id) => {
    const timer = pending.get(id)
    if (timer) clearTimeout(timer)
    pending.delete(id)
    await attempt(invoke('sources:delete', { id }), 'Could not delete the source')
    set({ sources: get().sources.filter((source) => source.id !== id), revision: get().revision + 1 })
  },

  flush: async () => {
    const ids = [...pending.keys()]
    for (const id of ids) {
      const timer = pending.get(id)
      if (timer) clearTimeout(timer)
      pending.delete(id)
      await saveNow(id)
    }
  }
}))

async function saveNow(id: string): Promise<void> {
  const source = useSourceStore.getState().sources.find((candidate) => candidate.id === id)
  if (!source) return
  await attempt(invoke('sources:save', { source }), 'Could not save the source')
}

/** Sources of the open project, for editors and the citation picker created outside React. */
export function currentSources(): CslItem[] {
  return useSourceStore.getState().sources
}
