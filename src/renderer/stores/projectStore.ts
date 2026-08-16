import { create } from 'zustand'
import type { OpenProject, ProjectManifest } from '@shared/model/manifest.js'
import type { NamedStyle } from '@shared/model/style.js'
import { BUILTIN_STYLES } from '@shared/model/style.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'

interface ProjectStore {
  project: OpenProject | null
  opening: boolean
  open: (uri: string) => Promise<OpenProject | null>
  openDialog: () => Promise<OpenProject | null>
  updateManifest: (update: (manifest: ProjectManifest) => ProjectManifest) => Promise<void>
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  project: null,
  opening: false,

  open: async (uri) => {
    set({ opening: true })
    const project = await attempt(invoke('project:open', { uri }), 'Could not open project')
    set({ project: project ?? get().project, opening: false })
    return project
  },

  openDialog: async () => {
    set({ opening: true })
    const project = await attempt(invoke('project:openDialog', {}), 'Could not open project')
    set({ project: project ?? get().project, opening: false })
    return project
  },

  updateManifest: async (update) => {
    const current = get().project
    if (!current || current.readOnly) return
    const next = update(current.manifest)
    // Show the change immediately — style edits should feel instant — and let
    // the write happen behind it.
    set({ project: { ...current, manifest: next } })
    const saved = await attempt(
      invoke('project:updateManifest', { manifest: next }),
      'Could not save project settings'
    )
    if (saved) {
      const latest = get().project
      if (latest) set({ project: { ...latest, manifest: saved } })
    }
  }
}))

/** Styles for the open project, falling back to the built-ins before one is open. */
export function currentStyles(): NamedStyle[] {
  return useProjectStore.getState().project?.manifest.styles ?? BUILTIN_STYLES
}
