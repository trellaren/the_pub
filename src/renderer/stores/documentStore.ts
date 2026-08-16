import { create } from 'zustand'
import type { Editor } from '@tiptap/core'
import type { PubDocument, PmDoc } from '@shared/model/document.js'
import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS } from '@shared/constants.js'
import { invoke, attempt, reportError, errorMessage } from '@renderer/lib/ipc.js'
import { createEditor } from '@renderer/panels/editor/createEditor.js'
import { useProjectStore, currentStyles } from './projectStore.js'
import { currentEntities } from './entityStore.js'
import { currentSources } from './sourceStore.js'

export interface OpenDocument {
  docId: string
  path: string
  title: string
  dirty: boolean
  saving: boolean
  /** Set when the file changed underneath us; the editor shows a keep/reload bar. */
  conflict: boolean
  /**
   * The file on disk was written by a newer version of The Pub. Autosave has
   * stopped trying — this build cannot rewrite it without a chance of losing
   * whatever it doesn't yet understand — and the editor goes read-only.
   */
  tooNew: boolean
  /** The file backing this panel has disappeared. */
  missing: boolean
  /** Last mtime we know about, used to detect outside edits. */
  mtime: number | null
  envelope: PubDocument
}

/**
 * Editor instances live here rather than in the store: they are large, mutable
 * and not serializable, and React components must not re-render because a
 * keystroke changed one.
 */
const editors = new Map<string, Editor>()

interface SaveTimer {
  timeout: ReturnType<typeof setTimeout>
  /** When this document first became dirty, so `maxWait` can be honoured. */
  firstDirtyAt: number
}
const timers = new Map<string, SaveTimer>()
/** Documents whose save is in flight, to keep concurrent saves off the same file. */
const saving = new Set<string>()

interface DocumentStore {
  docs: Record<string, OpenDocument>
  /** Most recently focused editor, for toolbar and command targeting. */
  activeDocId: string | null
  setActive: (docId: string | null) => void
  openPath: (path: string) => Promise<string | null>
  openDocId: (docId: string, fallbackPath?: string) => Promise<string | null>
  create: (path: string, title?: string) => Promise<string | null>
  close: (docId: string) => void
  save: (docId: string) => Promise<void>
  saveAll: () => Promise<void>
  flushAll: () => Promise<void>
  reload: (docId: string) => Promise<void>
  keepMine: (docId: string) => Promise<void>
  handleExternalChanges: (paths: string[]) => Promise<void>
  renamePath: (from: string, to: string) => void
}

export const useDocumentStore = create<DocumentStore>((set, get) => {
  function patch(docId: string, changes: Partial<OpenDocument>): void {
    const existing = get().docs[docId]
    if (!existing) return
    set({ docs: { ...get().docs, [docId]: { ...existing, ...changes } } })
  }

  /**
   * Queue a save. Waits for a pause in typing, but never longer than
   * `autosaveMaxWaitMs` from the first unsaved keystroke, so a writer in flow
   * still gets their work on disk.
   */
  function schedule(docId: string): void {
    const settings = useProjectStore.getState().project?.manifest.settings
    const debounce = settings?.autosaveDebounceMs ?? AUTOSAVE_DEBOUNCE_MS
    const maxWait = settings?.autosaveMaxWaitMs ?? AUTOSAVE_MAX_WAIT_MS

    const existing = timers.get(docId)
    const firstDirtyAt = existing?.firstDirtyAt ?? Date.now()
    if (existing) clearTimeout(existing.timeout)

    const elapsed = Date.now() - firstDirtyAt
    const delay = Math.max(0, Math.min(debounce, maxWait - elapsed))
    const timeout = setTimeout(() => {
      timers.delete(docId)
      void get().save(docId)
    }, delay)
    timers.set(docId, { timeout, firstDirtyAt })
  }

  function attach(loaded: { doc: PubDocument; path: string; mtime: number }): string {
    const { doc, path, mtime } = loaded
    const editor = createEditor({
      content: doc.content,
      getStyles: currentStyles,
      getEntities: currentEntities,
      getSources: currentSources,
      getCitationStyleId: () =>
        useProjectStore.getState().project?.manifest.settings.citationStyleId ?? 'chicago-author-date',
      getLocations: () => currentEntities().filter((entity) => entity.kind === 'location'),
      onUpdate: () => {
        const state = get().docs[doc.docId]
        if (!state) return
        if (!state.dirty) patch(doc.docId, { dirty: true })
        schedule(doc.docId)
      }
    })
    editors.set(doc.docId, editor)
    set({
      docs: {
        ...get().docs,
        [doc.docId]: {
          docId: doc.docId,
          path,
          title: doc.title,
          dirty: false,
          saving: false,
          conflict: false,
          tooNew: false,
          missing: false,
          mtime,
          envelope: doc
        }
      }
    })
    return doc.docId
  }

  return {
    docs: {},
    activeDocId: null,

    setActive: (docId) => set({ activeDocId: docId }),

    openPath: async (path) => {
      const already = Object.values(get().docs).find((candidate) => candidate.path === path)
      if (already) return already.docId
      const loaded = await attempt(invoke('doc:read', { path }), `Could not open ${path}`)
      if (!loaded) return null
      return attach(loaded)
    },

    openDocId: async (docId, fallbackPath) => {
      if (get().docs[docId]) return docId
      // Prefer the id: the file may have been renamed or moved since the layout
      // that referenced it was saved.
      const resolved = await invoke('doc:resolve', { docId }).catch(() => null)
      const path = resolved?.path ?? fallbackPath
      if (!path) return null
      const loaded = await invoke('doc:read', { path }).catch(() => null)
      if (!loaded) return null
      return attach(loaded)
    },

    create: async (path, title) => {
      const created = await attempt(invoke('doc:create', { path, title }), `Could not create ${path}`)
      if (!created) return null
      return attach(created)
    },

    close: (docId) => {
      const timer = timers.get(docId)
      if (timer) {
        clearTimeout(timer.timeout)
        timers.delete(docId)
      }
      const state = get().docs[docId]
      // Never drop unsaved work just because a tab was closed.
      if (state?.dirty) void get().save(docId)
      editors.get(docId)?.destroy()
      editors.delete(docId)
      const { [docId]: _removed, ...rest } = get().docs
      set({ docs: rest, activeDocId: get().activeDocId === docId ? null : get().activeDocId })
    },

    save: async (docId) => {
      const state = get().docs[docId]
      const editor = editors.get(docId)
      if (!state || !editor || state.missing) return
      // The manifest is newer than this build; the project opened read-only
      // rather than risk a save that can't round-trip it. Not this document's
      // problem to solve, but the project-level bar already says so.
      if (useProjectStore.getState().project?.readOnly) return
      if (saving.has(docId)) {
        // A save is already writing; make sure the newer content follows it.
        schedule(docId)
        return
      }
      saving.add(docId)
      patch(docId, { saving: true, dirty: false })

      const content = editor.getJSON() as PmDoc
      const envelope: PubDocument = { ...state.envelope, content }
      try {
        const result = await invoke('doc:write', {
          path: state.path,
          doc: envelope,
          expectedMtime: state.mtime
        })
        if (result.ok) {
          patch(docId, { saving: false, mtime: result.mtime, envelope, conflict: false })
        } else if (result.reason === 'conflict') {
          // Someone else wrote the file. Keep the buffer dirty so nothing is lost
          // and let the writer choose.
          patch(docId, { saving: false, dirty: true, conflict: true })
        } else {
          // The file on disk is newer than this build understands. Keep the
          // buffer dirty — nothing here is lost — but there is no choice to
          // offer: overwriting would risk destroying content this build can't
          // even see. The editor goes read-only instead of retrying forever.
          patch(docId, { saving: false, dirty: true, tooNew: true })
        }
      } catch (error) {
        patch(docId, { saving: false, dirty: true })
        reportError(`Could not save ${state.path}: ${errorMessage(error)}`)
      } finally {
        saving.delete(docId)
      }
    },

    saveAll: async () => {
      await Promise.all(
        Object.values(get().docs)
          .filter((state) => state.dirty)
          .map((state) => get().save(state.docId))
      )
    },

    /** Write every pending change now — used before a window closes. */
    flushAll: async () => {
      for (const [docId, timer] of timers) {
        clearTimeout(timer.timeout)
        timers.delete(docId)
      }
      await get().saveAll()
    },

    reload: async (docId) => {
      const state = get().docs[docId]
      const editor = editors.get(docId)
      if (!state || !editor) return
      const loaded = await attempt(invoke('doc:read', { path: state.path }), `Could not reload ${state.path}`)
      if (!loaded) return
      editor.commands.setContent(loaded.doc.content, { emitUpdate: false })
      patch(docId, {
        dirty: false,
        conflict: false,
        tooNew: false,
        missing: false,
        mtime: loaded.mtime,
        envelope: loaded.doc,
        title: loaded.doc.title
      })
    },

    /** Resolve a conflict by overwriting whatever is on disk with the open buffer. */
    keepMine: async (docId) => {
      patch(docId, { mtime: null, conflict: false, dirty: true })
      await get().save(docId)
    },

    handleExternalChanges: async (paths) => {
      const changed = new Set(paths)
      for (const state of Object.values(get().docs)) {
        if (!changed.has(state.path)) continue
        const stat = await invoke('vfs:stat', { path: state.path }).catch(() => null)
        if (!stat) {
          patch(state.docId, { missing: true })
          continue
        }
        if (stat.mtime === undefined || stat.mtime === state.mtime) continue
        // The file moved on without us. A clean buffer can just adopt it; a dirty
        // one must ask.
        if (state.dirty || state.saving) patch(state.docId, { conflict: true })
        else await get().reload(state.docId)
      }
    },

    renamePath: (from, to) => {
      const state = Object.values(get().docs).find((candidate) => candidate.path === from)
      if (state) patch(state.docId, { path: to, missing: false })
    }
  }
})

export function getEditor(docId: string): Editor | undefined {
  return editors.get(docId)
}

export function hasUnsavedWork(): boolean {
  return Object.values(useDocumentStore.getState().docs).some((state) => state.dirty || state.saving)
}
