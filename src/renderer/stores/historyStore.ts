import { create } from 'zustand'
import type { Snapshot } from '@shared/model/snapshot.js'
import type { PubDocument } from '@shared/model/document.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'
import { useDocumentStore } from './documentStore.js'

interface HistoryStore {
  /** The document the panel is following, or null when nothing is open. */
  docId: string | null
  /** Newest first, which is the order they are read in. */
  snapshots: Snapshot[]
  selected: string | null
  /** The selected version's content, once fetched. */
  version: PubDocument | null
  /** What the document says right now, to compare a version against. */
  current: PubDocument | null
  loading: boolean
  follow: (docId: string | null) => Promise<void>
  refresh: () => Promise<void>
  select: (timestamp: string | null) => Promise<void>
  restoreInPlace: (timestamp: string) => Promise<boolean>
  restoreToNewFile: (timestamp: string, targetPath: string) => Promise<string | null>
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  docId: null,
  snapshots: [],
  selected: null,
  version: null,
  current: null,
  loading: false,

  follow: async (docId) => {
    if (get().docId === docId) return
    set({ docId, snapshots: [], selected: null, version: null, current: null })
    if (docId) await get().refresh()
  },

  refresh: async () => {
    const docId = get().docId
    if (!docId) return
    set({ loading: true })
    const list = await attempt(invoke('snapshot:list', { docId }), 'Could not read the history')
    set({
      // Newest first: the version you want back is nearly always a recent one.
      snapshots: [...(list ?? [])].reverse(),
      loading: false
    })
  },

  select: async (timestamp) => {
    const docId = get().docId
    if (!docId || !timestamp) {
      set({ selected: null, version: null, current: null })
      return
    }
    set({ selected: timestamp, loading: true })

    const state = useDocumentStore.getState().docs[docId]
    const [version, current] = await Promise.all([
      attempt(invoke('snapshot:read', { docId, timestamp }), 'Could not read that version'),
      state ? invoke('doc:read', { path: state.path }).catch(() => null) : Promise.resolve(null)
    ])
    // Only settle if this is still the version being asked about: a quick walk
    // down the list starts several reads, and a slow one must not overwrite a
    // later selection's answer.
    if (get().selected !== timestamp) return
    set({ version: version ?? null, current: current?.doc ?? null, loading: false })
  },

  restoreInPlace: async (timestamp) => {
    const docId = get().docId
    if (!docId) return false

    // Flush first, so unsaved work becomes a version of its own rather than
    // being lost to the restore — and so the write below is not refused for
    // conflicting with a document the renderer itself had moved on from.
    const state = useDocumentStore.getState().docs[docId]
    if (state?.dirty) await useDocumentStore.getState().save(docId)

    const result = await attempt(
      invoke('snapshot:restore', { mode: 'inPlace', docId, timestamp }),
      'Could not restore that version'
    )
    if (!result?.ok) return false

    await useDocumentStore.getState().reload(docId)
    await get().refresh()
    return true
  },

  restoreToNewFile: async (timestamp, targetPath) => {
    const docId = get().docId
    if (!docId) return null
    const result = await attempt(
      invoke('snapshot:restore', { mode: 'newFile', docId, timestamp, targetPath }),
      'Could not write the restored copy'
    )
    return result?.ok ? result.path : null
  }
}))
