import type { TypedPubBridge } from '../src/preload/index.js'
import type { StoryEntity } from '../src/shared/model/entity.js'
import type { MentionHit } from '../src/shared/model/mention.js'
import type { Beat, BoardColumn } from '../src/shared/model/beat.js'
import type { StoryMap, MapShape, MapShapeKind, Point } from '../src/shared/model/map.js'
import type { Chat, AiSettings } from '../src/shared/model/ai.js'
import type { ManuscriptView, PartRole } from '../src/shared/model/manuscript.js'
import type { Note } from '../src/shared/model/note.js'
import type { OpenProject } from '../src/shared/model/manifest.js'
import type { CslItem } from '../src/shared/model/source.js'

/** Shape of the renderer test hook installed in `src/renderer/main.tsx`. */
interface PubTestHook {
  project: {
    getState: () => {
      open: (uri: string) => Promise<unknown>
      project: OpenProject | null
      updateManifest: (update: (manifest: OpenProject['manifest']) => OpenProject['manifest']) => Promise<void>
    }
  }
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
      api: {
        panels: { id: string }[]
        getPanel: (id: string) => { group: { id: string; api: { width: number } } } | undefined
        toJSON: () => unknown
      } | null
    }
  }
  history: {
    getState: () => {
      snapshots: { docId: string; timestamp: string; size: number; wordCount: number }[]
      selected: string | null
      follow: (docId: string | null) => Promise<void>
      refresh: () => Promise<void>
      select: (timestamp: string | null) => Promise<void>
      restoreInPlace: (timestamp: string) => Promise<boolean>
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
      create: (
        name: string,
        options?: { background?: string | null; width?: number; height?: number }
      ) => Promise<StoryMap | null>
      remove: (id: string) => Promise<void>
      setBackground: (
        id: string,
        background: string | null,
        size?: { width: number; height: number }
      ) => void
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
  chats: {
    getState: () => {
      chats: Chat[]
      settings: AiSettings | null
      activeChatId: string | null
      load: () => Promise<void>
      createChat: (title?: string) => Promise<Chat | null>
      deleteChat: (id: string) => Promise<void>
      saveSettings: (settings: AiSettings) => Promise<void>
      send: (chatId: string, text: string, context: string) => Promise<void>
    }
  }
  manuscript: {
    getState: () => {
      view: ManuscriptView
      collapsed: Set<string>
      load: () => Promise<void>
      toggleCollapsed: (partId: string) => void
      createPart: (title: string, role?: PartRole) => Promise<void>
      addDocuments: (paths: string[], parentId?: string | null) => Promise<void>
      move: (id: string, parentId: string | null, index: number) => Promise<void>
      rename: (id: string, title: string) => Promise<void>
      setRole: (id: string, role: PartRole) => Promise<void>
      relink: (id: string, path: string) => Promise<void>
      remove: (id: string) => Promise<void>
    }
  }
  notes: {
    getState: () => {
      notesByDoc: Record<string, Note[]>
      loadForDoc: (docId: string) => Promise<void>
      create: (docId: string, anchorId: string, anchorText: string, blockIndex: number) => Promise<Note | null>
      patch: (docId: string, noteId: string, changes: Partial<Note>) => void
      remove: (docId: string, noteId: string) => Promise<void>
      flush: () => Promise<void>
    }
  }
  sources: {
    getState: () => {
      sources: CslItem[]
      load: () => Promise<void>
      create: (type: string) => Promise<CslItem | null>
      patch: (id: string, changes: Partial<CslItem>) => void
      remove: (id: string) => Promise<void>
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
