import { create } from 'zustand'
import type { Beat, BoardColumn } from '@shared/model/beat.js'
import { placeInColumn, placeInChronology } from '@shared/model/beat.js'
import { BEAT_SAVE_DEBOUNCE_MS } from '@shared/constants.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'

interface BeatStore {
  beats: Beat[]
  columns: BoardColumn[]
  loaded: boolean
  load: () => Promise<void>
  create: (title: string, columnId?: string, docId?: string | null) => Promise<Beat | null>
  patch: (id: string, changes: Partial<Beat>) => void
  remove: (id: string) => Promise<void>
  /** Drop a beat at `index` of a storyboard column. */
  moveInColumn: (id: string, columnId: string, index: number) => void
  /** Drop a beat at `index` of the chronological list. */
  moveInChronology: (id: string, index: number) => void
  saveColumns: (columns: BoardColumn[]) => Promise<void>
  flush: () => Promise<void>
}

/** Debounce timers by beat id, outside the store so scheduling never renders. */
const pending = new Map<string, ReturnType<typeof setTimeout>>()

export const useBeatStore = create<BeatStore>((set, get) => ({
  beats: [],
  columns: [],
  loaded: false,

  load: async () => {
    const file = await attempt(invoke('beats:list', {}), 'Could not load the story board')
    if (!file) return
    set({ beats: file.beats, columns: file.columns, loaded: true })
  },

  create: async (title, columnId, docId) => {
    const beat = await attempt(
      invoke('beats:create', { title, columnId, docId: docId ?? null }),
      'Could not add the beat'
    )
    if (!beat) return null
    set({ beats: [...get().beats, beat] })
    return beat
  },

  patch: (id, changes) => {
    set({ beats: get().beats.map((beat) => (beat.id === id ? { ...beat, ...changes } : beat)) })
    schedule(id)
  },

  remove: async (id) => {
    cancel(id)
    await attempt(invoke('beats:delete', { id }), 'Could not delete the beat')
    set({ beats: get().beats.filter((beat) => beat.id !== id) })
  },

  moveInColumn: (id, columnId, index) => {
    // A drag rewrites the one beat that moved, not every beat after it: the
    // fractional key is what keeps a reorder to a single file write.
    get().patch(id, placeInColumn(get().beats, id, columnId, index))
  },

  moveInChronology: (id, index) => {
    const beat = get().beats.find((candidate) => candidate.id === id)
    if (!beat) return
    const sort = placeInChronology(get().beats, id, index)
    get().patch(id, { when: { ...beat.when, sort } })
  },

  saveColumns: async (columns) => {
    set({ columns })
    const saved = await attempt(invoke('beats:saveColumns', { columns }), 'Could not save the board')
    if (!saved) return
    // Deleting a column moves its beats, so the beats have to come back too.
    const file = await invoke('beats:list', {}).catch(() => null)
    if (file) set({ beats: file.beats, columns: file.columns })
  },

  flush: async () => {
    for (const id of [...pending.keys()]) {
      cancel(id)
      await saveNow(id)
    }
  }
}))

function cancel(id: string): void {
  const timer = pending.get(id)
  if (timer) clearTimeout(timer)
  pending.delete(id)
}

function schedule(id: string): void {
  cancel(id)
  pending.set(
    id,
    setTimeout(() => {
      pending.delete(id)
      void saveNow(id)
    }, BEAT_SAVE_DEBOUNCE_MS)
  )
}

async function saveNow(id: string): Promise<void> {
  const beat = useBeatStore.getState().beats.find((candidate) => candidate.id === id)
  if (!beat) return
  const saved = await attempt(invoke('beats:save', { beat }), 'Could not save the beat')
  if (!saved) return
  // Take the server's derived sort key and timestamps, but keep whatever the
  // author typed while the write was in flight.
  const current = useBeatStore.getState().beats.find((candidate) => candidate.id === id)
  if (!current) return
  useBeatStore.setState({
    beats: useBeatStore
      .getState()
      .beats.map((candidate) =>
        candidate.id === id
          ? { ...current, when: { ...current.when, sort: saved.when.sort }, modified: saved.modified }
          : candidate
      )
  })
}
