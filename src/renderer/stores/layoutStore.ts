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
  showPanel: (component: PanelComponent, title: string, options?: ShowPanelOptions) => void
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
  /** Every record kind, parameterised — see `EntityPanel.tsx`'s `RecordsPanel`. */
  | 'records'
  /** Pre-Phase-6 ids, kept only so an old saved layout still resolves. */
  | 'characters'
  | 'locations'
  | 'timeline'
  | 'storyboard'
  | 'maps'
  | 'ai'
  | 'manuscript'
  | 'history'
  | 'settings'
  | 'notes'
  | 'sources'
  | 'review'

interface ShowPanelOptions {
  /** Defaults to `component` — set for a component multiple singletons share, like `records`, so each kind gets its own panel id. */
  panelId?: string
  params?: Record<string, unknown>
}

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
  showPanel: (component, title, options) => {
    const api = get().api
    if (!api) return
    const id = options?.panelId ?? component
    const existing = api.getPanel(id)
    if (existing) {
      existing.api.setActive()
      return
    }
    const placement = placementFor(api, component)
    api.addPanel({
      id,
      component,
      title,
      ...(options?.params ? { params: options.params } : {}),
      // Always positioned against a panel that already exists. A bare
      // `{ direction }` is an absolute position, which dockview resolves against
      // the grid root: it mints a fresh top-level column every time, so each
      // panel opened shrank every other one and shouldered the Explorer further
      // from the edge it is supposed to occupy.
      ...(placement ? { position: placement } : {})
    })
    api.getPanel(id)?.api.setActive()
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

/**
 * The panels that belong in the narrow column beside the manuscript.
 *
 * They are the ones you consult while writing — a file list, a search, a set of
 * styles — and they read fine at sidebar width.
 */
const SIDEBAR_PANELS = new Set<PanelComponent>([
  'explorer',
  'search',
  'styles',
  'records',
  'characters',
  'locations',
  'notes',
  'sources',
  'review'
])

/**
 * The panels you work in rather than glance at.
 *
 * These want room, so they open where the documents are instead of being
 * squeezed into the sidebar — a storyboard 280px wide is not a storyboard.
 */
const WORKSPACE_PANELS = new Set<PanelComponent>([
  'ai',
  'manuscript',
  'timeline',
  'storyboard',
  'maps',
  'history'
])

/**
 * Where a singleton panel should open.
 *
 * Always a tab in a group that already exists — never a split, and never a new
 * column. A tab takes no room from anything, so opening a panel cannot resize
 * the layout at all, and it arrives somewhere obvious: at the front of a group,
 * with a tab you can see and drag wherever you actually want it.
 *
 * Which group depends on what the panel is for. A file list, a search or a style
 * sheet is something you consult while writing and reads fine in the sidebar; a
 * binder, a board, a map or a chat is somewhere you work, and belongs where the
 * documents are. Each falls back to the other's home, so a panel still lands
 * somewhere sane in a layout with no sidebar or nothing open.
 */
function placementFor(
  api: DockviewApi,
  component: PanelComponent
): { referencePanel: string; direction: 'within' } | undefined {
  // A panel's own id, not its component, once a component like `records` is
  // shared by several singletons (one per kind) with different ids — falling
  // back to `id` keeps this working for every other component, where the two
  // still match.
  const componentOf = (panel: (typeof api.panels)[number]): PanelComponent =>
    (panel.toJSON().contentComponent ?? panel.id) as PanelComponent
  const sidebar = api.panels.find((panel) => SIDEBAR_PANELS.has(componentOf(panel)))
  const workspace = api.panels.find((panel) => WORKSPACE_PANELS.has(componentOf(panel)))
  const editor = editorGroupPanel(api)

  const target = SIDEBAR_PANELS.has(component)
    ? (sidebar ?? editor ?? workspace)
    : (editor ?? workspace ?? sidebar)
  return target ? { referencePanel: target.id, direction: 'within' } : undefined
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
