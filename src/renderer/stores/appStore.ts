import { create } from 'zustand'
import type { AppState } from '@shared/model/app.js'
import { invoke, on } from '@renderer/lib/ipc.js'
import { applyToAllDocuments, registerDocumentEffect } from '@renderer/lib/documents.js'

/** What a rejected rebinding was rejected for; null when it was accepted. */
export type KeybindingResult =
  | null
  | { reason: 'invalid' | 'unknown-command' }
  | { reason: 'conflict'; conflictWith: string }

interface AppStore {
  state: AppState | null
  setState: (state: AppState) => void
  setTheme: (theme: AppState['theme']) => Promise<void>
  setTimelineOrientation: (orientation: AppState['timelineOrientation']) => Promise<void>
  setAiEnabled: (enabled: boolean) => Promise<void>
  setEmbeddedIdleMinutes: (minutes: number) => Promise<void>
  setKeybinding: (commandId: string, accelerator: string | null) => Promise<KeybindingResult>
  resetKeybindings: () => Promise<void>
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
  setTheme: async (theme) => {
    const next = await invoke('app:setTheme', { theme })
    get().setState(next)
  },
  setTimelineOrientation: async (orientation) => {
    const next = await invoke('app:setTimelineOrientation', { orientation })
    get().setState(next)
  },
  setAiEnabled: async (enabled) => {
    get().setState(await invoke('app:setAiEnabled', { enabled }))
  },
  setEmbeddedIdleMinutes: async (minutes) => {
    get().setState(await invoke('app:setEmbeddedIdleMinutes', { minutes }))
  },
  setKeybinding: async (commandId, accelerator) => {
    const result = await invoke('app:setKeybinding', { commandId, accelerator })
    if (!result.ok) {
      return result.reason === 'conflict'
        ? { reason: 'conflict', conflictWith: result.conflictWith }
        : { reason: result.reason }
    }
    get().setState(result.state)
    return null
  },
  resetKeybindings: async () => {
    get().setState(await invoke('app:resetKeybindings', {}))
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
