import type { TypedPubBridge } from '../src/preload/index.js'

/** Shape of the renderer test hook installed in `src/renderer/main.tsx`. */
interface PubTestHook {
  project: { getState: () => { open: (uri: string) => Promise<unknown>; project: { root: string } | null } }
  documents: {
    getState: () => {
      create: (path: string, title?: string) => Promise<string | null>
      openPath: (path: string) => Promise<string | null>
      save: (docId: string) => Promise<void>
      flushAll: () => Promise<void>
      docs: Record<string, { docId: string; path: string; title: string; dirty: boolean }>
    }
  }
  layout: {
    getState: () => {
      openEditor: (docId: string, path: string, title: string) => void
      popoutActiveGroup: () => void
      api: { panels: { id: string }[]; toJSON: () => unknown } | null
    }
  }
  runCommand: (id: string) => boolean
}

declare global {
  interface Window {
    pub: TypedPubBridge
    __pub: PubTestHook
  }
}

export {}
