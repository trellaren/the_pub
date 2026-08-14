import type { TypedPubBridge } from '../src/preload/index.js'
import type { StoryEntity } from '../src/shared/model/entity.js'
import type { MentionHit } from '../src/shared/model/mention.js'

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
  entities: {
    getState: () => {
      entities: StoryEntity[]
      create: (kind: 'character' | 'location', name: string) => Promise<StoryEntity | null>
      patch: (id: string, changes: Partial<StoryEntity>) => void
      flush: () => Promise<void>
    }
  }
  confirmMention: (hit: MentionHit, entity: StoryEntity) => Promise<boolean>
  openLocation: (location: {
    path: string
    title: string
    blockIndex: number
    term?: string
  }) => Promise<boolean>
  runCommand: (id: string) => boolean
}

declare global {
  interface Window {
    pub: TypedPubBridge
    __pub: PubTestHook
  }
}

export {}
