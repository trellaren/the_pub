import { create } from 'zustand'
import type { OpenProject, ProjectManifest } from '@shared/model/manifest.js'
import type { NamedStyle } from '@shared/model/style.js'
import { BUILTIN_STYLES } from '@shared/model/style.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'
import { useAppStore } from './appStore.js'

interface ProjectStore {
  project: OpenProject | null
  opening: boolean
  /** What is being opened, for the overlay; null when the name isn't known yet. */
  openingName: string | null
  open: (uri: string, name?: string) => Promise<OpenProject | null>
  openDialog: () => Promise<OpenProject | null>
  newFromTemplate: (templateId: string, name: string) => Promise<OpenProject | null>
  forgetRecent: (uri: string) => Promise<void>
  updateManifest: (update: (manifest: ProjectManifest) => ProjectManifest) => Promise<void>
}

let beforeSwitch: () => Promise<void> = async () => {}

/**
 * Registered by the app shell rather than imported here: the stores that hold
 * pending writes themselves import this one. Main closes the old session as
 * soon as the new one is open, so anything still debounced must be written
 * first — afterwards it would go to the new project, or nowhere.
 */
export function onBeforeProjectSwitch(flush: () => Promise<void>): void {
  beforeSwitch = flush
}

let manifestRequest = 0

let projectLost:() => Promise<void> = async () => {}

/**
 * Registered by the app shell for the same reason as `onBeforeProjectSwitch`:
 * when a failed open leaves nothing open in main, every panel, editor and
 * record of the old project has to go, or each autosave fails against a
 * session that no longer exists.
 */
export function onProjectLost(reset: () => Promise<void>): void {
  projectLost = reset
}

/**
 * What is still open in main after a failed open of `uri`. Main keeps the
 * current session unless the open was a reopen of that same project, which it
 * has to close first.
 */
export function survivorOf(current: OpenProject | null, uri: string): OpenProject | null {
  return current?.uri === uri ? null : current
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  project: null,
  opening: false,
  openingName: null,

  open: async (uri, name) => {
    if (get().opening) return null
    set({ opening: true, openingName: name ?? null })
    await beforeSwitch()
    const project = await attempt(invoke('project:open', { uri }), 'Could not open project')
    const previous = get().project
    const survivor = project ?? survivorOf(previous, uri)
    set({ project: survivor, opening: false, openingName: null })
    if (project) void useAppStore.getState().load().catch(() => {})
    else if (previous && !survivor) await projectLost()
    return project
  },

  openDialog: async () => {
    if (get().opening) return null
    set({ opening: true, openingName: null })
    await beforeSwitch()
    const project = await attempt(invoke('project:openDialog', {}), 'Could not open project')
    set({ project: project ?? get().project, opening: false, openingName: null })
    if (project) void useAppStore.getState().load().catch(() => {})
    return project
  },

  newFromTemplate: async (templateId, name) => {
    if (get().opening) return null
    set({ opening: true, openingName: name })
    await beforeSwitch()
    const project = await attempt(
      invoke('templates:instantiate', { templateId, name }),
      'Could not create the project'
    )
    set({ project: project ?? get().project, opening: false, openingName: null })
    if (project) void useAppStore.getState().load().catch(() => {})
    return project
  },

  forgetRecent: async (uri) => {
    const state = await attempt(invoke('project:forgetRecent', { uri }), 'Could not remove it from Recent')
    if (state) useAppStore.getState().setState(state)
  },

  updateManifest: async (update) => {
    const current = get().project
    if (!current || current.readOnly) return
    const next = update(current.manifest)
    // Show the change immediately — style edits should feel instant — and let
    // the write happen behind it.
    set({ project: { ...current, manifest: next } })
    const request = ++manifestRequest
    const saved = await attempt(
      invoke('project:updateManifest', { manifest: next }),
      'Could not save project settings'
    )
    // A newer edit has already been shown and will settle itself; and a reply
    // for a project that is no longer open has nothing to land on.
    const latest = get().project
    if (request !== manifestRequest || !latest || latest.uri !== current.uri) return
    set({ project: { ...latest, manifest: saved ?? current.manifest } })
  }
}))

/** Styles for the open project, falling back to the built-ins before one is open. */
export function currentStyles(): NamedStyle[] {
  return useProjectStore.getState().project?.manifest.styles ?? BUILTIN_STYLES
}
