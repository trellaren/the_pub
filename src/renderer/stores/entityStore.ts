import { create } from 'zustand'
import type { StoryEntity, EntityKind, DismissedMention } from '@shared/model/entity.js'
import type { MentionCounts } from '@shared/model/mention.js'
import { ENTITY_SAVE_DEBOUNCE_MS } from '@shared/constants.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'

interface EntityStore {
  entities: StoryEntity[]
  dismissed: DismissedMention[]
  counts: Record<string, MentionCounts>
  loaded: boolean
  load: () => Promise<void>
  refreshCounts: () => Promise<void>
  create: (kind: EntityKind, name: string) => Promise<StoryEntity | null>
  /** Optimistic edit; the write is debounced behind it. */
  patch: (id: string, changes: Partial<StoryEntity>) => void
  remove: (id: string) => Promise<void>
  /** Write any pending edit now. Called before the window closes. */
  flush: () => Promise<void>
}

/**
 * Debounce timers keyed by record id, kept outside the store so scheduling a
 * save never re-renders anything.
 *
 * The forms write straight through with no draft state — the pattern
 * StylesPanel established — so without this every keystroke in a Name field
 * would be a file write *and* a project-wide rescan.
 */
const pending = new Map<string, ReturnType<typeof setTimeout>>()

export const useEntityStore = create<EntityStore>((set, get) => ({
  entities: [],
  dismissed: [],
  counts: {},
  loaded: false,

  load: async () => {
    const file = await attempt(invoke('entities:list', {}), 'Could not load records')
    if (!file) return
    set({ entities: file.entities, dismissed: file.dismissed, loaded: true })
    await get().refreshCounts()
  },

  refreshCounts: async () => {
    const counts = await invoke('mentions:summary', {}).catch(() => null)
    if (counts) set({ counts })
  },

  create: async (kind, name) => {
    const entity = await attempt(invoke('entities:create', { kind, name }), 'Could not create record')
    if (!entity) return null
    set({ entities: [...get().entities, entity] })
    return entity
  },

  patch: (id, changes) => {
    const next = get().entities.map((entity) =>
      entity.id === id ? { ...entity, ...changes } : entity
    )
    set({ entities: next })

    const existing = pending.get(id)
    if (existing) clearTimeout(existing)
    pending.set(
      id,
      setTimeout(() => {
        pending.delete(id)
        void saveNow(id)
      }, ENTITY_SAVE_DEBOUNCE_MS)
    )
  },

  remove: async (id) => {
    const timer = pending.get(id)
    if (timer) clearTimeout(timer)
    pending.delete(id)
    await attempt(invoke('entities:delete', { id }), 'Could not delete record')
    set({ entities: get().entities.filter((entity) => entity.id !== id) })
    await get().refreshCounts()
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
  const entity = useEntityStore.getState().entities.find((candidate) => candidate.id === id)
  if (!entity) return
  const saved = await attempt(invoke('entities:save', { entity }), 'Could not save record')
  if (!saved) return
  // Keep the server's `modified` stamp, but do not clobber edits the user made
  // while the write was in flight.
  const current = useEntityStore.getState().entities.find((candidate) => candidate.id === id)
  if (current) {
    useEntityStore.setState({
      entities: useEntityStore
        .getState()
        .entities.map((candidate) =>
          candidate.id === id ? { ...current, modified: saved.modified } : candidate
        )
    })
  }
  await useEntityStore.getState().refreshCounts()
}

/** Records of the open project, for editors created outside React. */
export function currentEntities(): StoryEntity[] {
  return useEntityStore.getState().entities
}
