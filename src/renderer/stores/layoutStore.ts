import { create } from 'zustand'
import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import type { LayoutPreset, DockLayout } from '@shared/model/layout.js'
import { LAYOUT_SAVE_DEBOUNCE_MS } from '@shared/constants.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'
import { registerDocument, unregisterDocument } from '@renderer/lib/documents.js'
import { useProjectStore } from './projectStore.js'

export const EDITOR_PANEL_PREFIX = 'editor:'
export const SIDEBAR_WIDTH = 280

/**
 * The page dockview opens torn-off groups at.
 *
 * Resolved against the current document rather than hard-coded, because the app
 * is served over http in development and from `file://` once packaged — and a
 * root-relative `/popout.html` would point at the filesystem root in the latter.
 */
export function popoutUrl(): string {
  return new URL('popout.html', window.location.href).href
}

interface LayoutStore {
  api: DockviewApi | null
  presets: LayoutPreset[]
  setApi: (api: DockviewApi) => void
  openEditor: (docId: string, path: string, title: string) => void
  showPanel: (component: PanelComponent, title: string) => void
  popoutActiveGroup: () => void
  savePreset: (name: string) => Promise<void>
  applyPreset: (id: string) => void
  deletePreset: (id: string) => Promise<void>
  loadPresets: () => Promise<void>
  reset: () => void
}

export type PanelComponent =
  | 'explorer'
  | 'search'
  | 'editor'
  | 'welcome'
  | 'styles'
  | 'characters'
  | 'locations'

let saveTimer: ReturnType<typeof setTimeout> | null = null

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  api: null,
  presets: [],

  setApi: (api) => set({ api }),

  openEditor: (docId, path, title) => {
    const api = get().api
    if (!api) return
    const id = `${EDITOR_PANEL_PREFIX}${docId}`
    const existing = api.getPanel(id)
    if (existing) {
      existing.api.setActive()
      return
    }
    const target = editorGroupPanel(api)
    api.addPanel({
      id,
      component: 'editor',
      title,
      params: { docId, path },
      // Open beside the documents already on screen. With nothing to reference,
      // `position` is omitted entirely — a direction with no reference panel is
      // not a valid location and dockview rejects it.
      ...(target ? { position: { referencePanel: target.id, direction: 'within' as const } } : {})
    })
    api.getPanel(id)?.api.setActive()
  },

  /** Focus a singleton panel, creating it if the layout doesn't have one. */
  showPanel: (component, title) => {
    const api = get().api
    if (!api) return
    const existing = api.getPanel(component)
    if (existing) {
      existing.api.setActive()
      return
    }
    api.addPanel({ id: component, component, title, position: { direction: 'left' } })
    api.getPanel(component)?.api.setSize({ width: SIDEBAR_WIDTH })
  },

  popoutActiveGroup: () => {
    const api = get().api
    const group = api?.activeGroup
    if (!api || !group) return
    void api.addPopoutGroup(group, {
      popoutUrl: popoutUrl(),
      onDidOpen: ({ window: popout }) => registerDocument(popout.document),
      onWillClose: ({ window: popout }) => unregisterDocument(popout.document)
    })
  },

  savePreset: async (name) => {
    const api = get().api
    if (!api) return
    const preset = await attempt(
      invoke('layout:savePreset', { name, layout: api.toJSON() as unknown as DockLayout }),
      'Could not save layout preset'
    )
    if (preset) {
      set({ presets: [...get().presets.filter((item) => item.id !== preset.id), preset] })
    }
  },

  applyPreset: (id) => {
    const api = get().api
    const preset = get().presets.find((item) => item.id === id)
    if (!api || !preset) return
    restoreLayout(api, preset.layout)
  },

  deletePreset: async (id) => {
    await attempt(invoke('layout:deletePreset', { id }), 'Could not delete layout preset')
    set({ presets: get().presets.filter((preset) => preset.id !== id) })
  },

  loadPresets: async () => {
    const file = await attempt(invoke('layout:load', {}), 'Could not load layouts')
    if (file) set({ presets: file.presets })
  },

  reset: () => {
    const api = get().api
    if (api) buildDefaultLayout(api)
  }
}))

/** Where a newly opened document should go: alongside the documents already open. */
function editorGroupPanel(api: DockviewApi): IDockviewPanel | undefined {
  return (
    api.panels.find((panel) => panel.id.startsWith(EDITOR_PANEL_PREFIX)) ??
    api.getPanel('welcome') ??
    undefined
  )
}

export function buildDefaultLayout(api: DockviewApi): void {
  // Always start from nothing: this runs both at startup and when a project
  // without a saved layout is opened, and adding a panel id that already exists
  // is an error.
  api.clear()
  api.addPanel({ id: 'explorer', component: 'explorer', title: 'Explorer' })
  api.addPanel({
    id: 'search',
    component: 'search',
    title: 'Search',
    position: { referencePanel: 'explorer', direction: 'within' }
  })
  api.addPanel({
    id: 'welcome',
    component: 'welcome',
    title: 'Welcome',
    position: { referencePanel: 'explorer', direction: 'right' }
  })
  api.getPanel('explorer')?.api.setActive()
  api.getPanel('explorer')?.api.setSize({ width: SIDEBAR_WIDTH })
}

/**
 * Apply a stored layout, falling back to the default if it cannot be restored —
 * a layout that fails to load must never leave the user with a blank window.
 */
export function restoreLayout(api: DockviewApi, layout: DockLayout | null): void {
  if (!layout) {
    buildDefaultLayout(api)
    return
  }
  try {
    api.fromJSON(layout as never)
    if (api.panels.length === 0) buildDefaultLayout(api)
  } catch (error) {
    console.error('Could not restore layout:', error)
    buildDefaultLayout(api)
  }
}

/**
 * Persist the arrangement shortly after it settles. Layouts belong to a
 * project, so nothing is written until one is open — the default arrangement
 * built at startup is not worth saving anywhere.
 */
export function scheduleLayoutSave(api: DockviewApi): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!useProjectStore.getState().project) return
    void invoke('layout:saveLast', { layout: api.toJSON() as unknown as DockLayout }).catch(() => {})
  }, LAYOUT_SAVE_DEBOUNCE_MS)
}
