import type { TypedPubBridge } from '../src/preload/index.js'
import type { StoryEntity } from '../src/shared/model/entity.js'
import type { MentionHit } from '../src/shared/model/mention.js'
import type { Beat, BoardColumn } from '../src/shared/model/beat.js'
import type { StoryMap, MapShape, MapShapeKind, Point } from '../src/shared/model/map.js'

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
      showPanel: (component: string, title: string) => void
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
  beats: {
    getState: () => {
      beats: Beat[]
      columns: BoardColumn[]
      load: () => Promise<void>
      create: (title: string, columnId?: string, docId?: string | null) => Promise<Beat | null>
      patch: (id: string, changes: Partial<Beat>) => void
      moveInColumn: (id: string, columnId: string, index: number) => void
      moveInChronology: (id: string, index: number) => void
      flush: () => Promise<void>
    }
  }
  maps: {
    getState: () => {
      maps: StoryMap[]
      activeMapId: string | null
      load: () => Promise<void>
      setActive: (id: string | null) => void
      create: (name: string) => Promise<StoryMap | null>
      remove: (id: string) => Promise<void>
      addShape: (
        mapId: string,
        kind: MapShapeKind,
        points: Point[],
        text?: string
      ) => MapShape | null
      patchShape: (mapId: string, shapeId: string, changes: Partial<MapShape>) => void
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
