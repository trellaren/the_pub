import { create } from 'zustand'
import type { ManuscriptView } from '@shared/model/manuscript.js'
import type { PartRole } from '@shared/model/manuscript.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'

/**
 * The book's structure, as the panel sees it.
 *
 * Unlike beats and maps, nothing here is typed character by character — every
 * mutation is a discrete action (create a part, drop a chapter, click a
 * button) — so there is no debounce to manage. Each call round-trips to main
 * and replaces state with the resolved view it returns, which is also what
 * keeps this simple: a move can shift several rows' word roll-ups and depths,
 * and a renderer patching only the node it touched would drift from what
 * `reconcile` decided the moment a hand-edited file disagreed with it.
 */
interface ManuscriptStore {
  view: ManuscriptView
  loaded: boolean
  collapsed: Set<string>
  load: () => Promise<void>
  toggleCollapsed: (partId: string) => void
  createPart: (title: string, role?: PartRole) => Promise<void>
  addDocuments: (paths: string[], parentId?: string | null) => Promise<void>
  move: (id: string, parentId: string | null, index: number) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  setRole: (id: string, role: PartRole) => Promise<void>
  relink: (id: string, path: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

const EMPTY_VIEW: ManuscriptView = { nodes: [], resolving: false }

export const useManuscriptStore = create<ManuscriptStore>((set, get) => ({
  view: EMPTY_VIEW,
  loaded: false,
  collapsed: new Set(),

  load: async () => {
    const view = await attempt(invoke('manuscript:view', {}), 'Could not load the manuscript')
    if (!view) return
    set({ view, loaded: true })
  },

  toggleCollapsed: (partId) => {
    const next = new Set(get().collapsed)
    if (next.has(partId)) next.delete(partId)
    else next.add(partId)
    set({ collapsed: next })
  },

  createPart: async (title, role = 'body') => {
    const view = await attempt(invoke('manuscript:createPart', { title, role }), 'Could not add the part')
    if (view) set({ view })
  },

  addDocuments: async (paths, parentId = null) => {
    const view = await attempt(
      invoke('manuscript:addDocuments', { paths, parentId }),
      'Could not add the documents'
    )
    if (view) set({ view })
  },

  move: async (id, parentId, index) => {
    const view = await attempt(invoke('manuscript:move', { id, parentId, index }), 'Could not move that')
    if (view) set({ view })
  },

  rename: async (id, title) => {
    const view = await attempt(invoke('manuscript:rename', { id, title }), 'Could not rename that')
    if (view) set({ view })
  },

  setRole: async (id, role) => {
    const view = await attempt(invoke('manuscript:setRole', { id, role }), 'Could not change that part')
    if (view) set({ view })
  },

  relink: async (id, path) => {
    const view = await attempt(invoke('manuscript:relink', { id, path }), 'Could not relink that chapter')
    if (view) set({ view })
  },

  remove: async (id) => {
    const view = await attempt(invoke('manuscript:remove', { id }), 'Could not remove that')
    if (view) set({ view })
  }
}))
