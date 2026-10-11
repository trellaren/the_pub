import { useCallback } from 'react'
import { create } from 'zustand'
import { useProjectStore } from './projectStore.js'

/**
 * What each panel had selected, held outside the panel so closing, redocking
 * or tearing one off does not lose it — the dock unmounts a panel on every
 * one of those. In memory only: a selection is not worth a file on disk, and
 * it is cleared whenever a different project opens, since ids from one
 * project mean nothing in another.
 */
interface PanelSelectionStore {
  selections: Record<string, unknown>
  select: (key: string, value: unknown) => void
  clear: () => void
}

export const usePanelSelectionStore = create<PanelSelectionStore>((set, get) => ({
  selections: {},
  select: (key, value) => {
    if (get().selections[key] === value) return
    set({ selections: { ...get().selections, [key]: value } })
  },
  clear: () => set({ selections: {} })
}))

useProjectStore.subscribe((state, previous) => {
  if (state.project?.uri !== previous.project?.uri) usePanelSelectionStore.getState().clear()
})

export function usePanelSelection<T>(key: string, initial: T): [T, (next: T) => void] {
  const value = usePanelSelectionStore((store) =>
    key in store.selections ? (store.selections[key] as T) : initial
  )
  const setValue = useCallback((next: T) => usePanelSelectionStore.getState().select(key, next), [key])
  return [value, setValue]
}
