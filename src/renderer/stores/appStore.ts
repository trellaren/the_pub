import { create } from 'zustand'
import type { AppState } from '@shared/model/app.js'
import { invoke, on } from '@renderer/lib/ipc.js'
import { applyToAllDocuments, registerDocumentEffect } from '@renderer/lib/documents.js'

interface AppStore {
  state: AppState | null
  setState: (state: AppState) => void
  toggleTheme: () => Promise<void>
  load: () => Promise<void>
}

export const useAppStore = create<AppStore>((set, get) => ({
  state: null,
  setState: (state) => {
    set({ state })
    applyTheme(state.theme)
  },
  load: async () => {
    const state = await invoke('app:getState', {})
    get().setState(state)
  },
  toggleTheme: async () => {
    const current = get().state?.theme ?? 'dark'
    const next = await invoke('app:setTheme', { theme: current === 'dark' ? 'light' : 'dark' })
    get().setState(next)
  }
}))

function applyTheme(theme: AppState['theme']): void {
  applyToAllDocuments((target) => {
    target.documentElement.setAttribute('data-theme', theme)
    target.documentElement.style.colorScheme = theme
  })
}

// Popout windows open with a fresh <html>, so the theme has to be stamped on
// each one as it appears, not just on the main document.
registerDocumentEffect((target) => {
  const theme = useAppStore.getState().state?.theme ?? 'dark'
  target.documentElement.setAttribute('data-theme', theme)
  target.documentElement.style.colorScheme = theme
})

on('app:stateChanged', (state) => useAppStore.getState().setState(state))
