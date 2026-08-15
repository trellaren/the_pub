import { useEffect, useRef, useState } from 'react'
import { EditorContent } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useDocumentStore } from '@renderer/stores/documentStore.js'
import { useEntityStore } from '@renderer/stores/entityStore.js'
import { useHistoryStore } from '@renderer/stores/historyStore.js'
import { useLayoutStore } from '@renderer/stores/layoutStore.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton, cx } from '@renderer/ui/primitives.js'
import { promptForName } from '@renderer/ui/PromptDialog.js'
import { createEditor } from '@renderer/panels/editor/createEditor.js'
import { DiffView } from './DiffView.js'

type View = 'preview' | 'compare'

/**
 * The versions of the document being written.
 *
 * Every save has been archiving one for as long as the app has existed; until
 * now nothing could open them. The panel follows whichever document is active,
 * the way the editor's own toolbar does, rather than being opened against one
 * and going stale.
 */
export function HistoryPanel() {
  const project = useProjectStore((store) => store.project)
  const activeDocId = useDocumentStore((store) => store.activeDocId)
  const docs = useDocumentStore((store) => store.docs)
  const snapshots = useHistoryStore((store) => store.snapshots)
  const selected = useHistoryStore((store) => store.selected)
  const version = useHistoryStore((store) => store.version)
  const current = useHistoryStore((store) => store.current)
  const loading = useHistoryStore((store) => store.loading)

  const [view, setView] = useState<View>('preview')
  const paneRef = useRef<HTMLDivElement>(null)
  const document = activeDocId ? docs[activeDocId] : undefined

  useEffect(() => {
    void useHistoryStore.getState().follow(activeDocId)
  }, [activeDocId])

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>History</PanelHeader>
        <EmptyState title="No project open" />
      </PanelShell>
    )
  }

  if (!document) {
    return (
      <PanelShell>
        <PanelHeader>History</PanelHeader>
        <EmptyState title="No document open" hint="Open a document to see its earlier versions." />
      </PanelShell>
    )
  }

  const restore = async (): Promise<void> => {
    if (!selected) return
    const ok = window.confirm(
      'Replace the current version with this one? What is there now is saved to history first, so this can be undone.'
    )
    if (!ok) return
    await useHistoryStore.getState().restoreInPlace(selected)
  }

  const restoreCopy = async (): Promise<void> => {
    if (!selected) return
    const name = await promptForName({
      title: 'Restore into a new file',
      confirmLabel: 'Restore',
      defaultValue: document.path.replace(/\.pubdoc$/, '-earlier.pubdoc'),
      ownerDocument: paneRef.current?.ownerDocument
    })
    if (!name) return
    const path = await useHistoryStore.getState().restoreToNewFile(selected, name)
    if (!path) return
    const docId = await useDocumentStore.getState().openPath(path)
    if (docId) {
      useLayoutStore
        .getState()
        .openEditor(docId, path, useDocumentStore.getState().docs[docId]?.title ?? path)
    }
  }

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1 truncate">History — {document.title}</span>
        <ToolbarButton label="Show this version" active={view === 'preview'} onClick={() => setView('preview')} data-testid="history-preview-tab">
          Version
        </ToolbarButton>
        <ToolbarButton label="Compare with the current version" active={view === 'compare'} onClick={() => setView('compare')} data-testid="history-compare-tab">
          Changes
        </ToolbarButton>
      </PanelHeader>

      <div ref={paneRef} className="flex min-h-0 flex-1 overflow-hidden">
        <div className="w-56 shrink-0 overflow-y-auto border-r border-border" data-testid="history-list">
          {snapshots.length === 0 ? (
            <EmptyState
              title="No earlier versions"
              hint="Versions are kept as you write, thinning out as they age."
            />
          ) : (
            <ul>
              {snapshots.map((snapshot) => (
                <li key={snapshot.timestamp}>
                  <button
                    type="button"
                    data-testid="history-item"
                    onClick={() => void useHistoryStore.getState().select(snapshot.timestamp)}
                    className={cx(
                      'pub-focus-ring w-full px-3 py-2 text-left text-[12px]',
                      selected === snapshot.timestamp
                        ? 'bg-accent-soft text-accent'
                        : 'text-muted hover:bg-surface-2 hover:text-text'
                    )}
                  >
                    <span className="block">{when(snapshot.timestamp)}</span>
                    <span className="block text-[11px] text-faint">{sizeOf(snapshot.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!selected ? (
              <EmptyState title="Choose a version" hint="Pick one on the left to read it or see what changed." />
            ) : loading && !version ? (
              <EmptyState title="Opening…" />
            ) : !version ? (
              <EmptyState title="That version could not be read" />
            ) : view === 'preview' ? (
              <VersionPreview content={version.content} />
            ) : current ? (
              <DiffView before={version.content} after={current.content} />
            ) : (
              <EmptyState title="Nothing to compare against" />
            )}
          </div>

          {selected && version ? (
            <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
              <ToolbarButton label="Replace the document with this version" onClick={() => void restore()} data-testid="history-restore">
                Restore
              </ToolbarButton>
              <ToolbarButton label="Write this version to a new file" onClick={() => void restoreCopy()} data-testid="history-restore-copy">
                Restore into a new file…
              </ToolbarButton>
            </div>
          ) : null}
        </div>
      </div>
    </PanelShell>
  )
}

/**
 * The chosen version, read-only, in the sheet styling it was written in.
 *
 * Its own editor with its own lifetime — deliberately not one of the ones
 * `documentStore` keeps, which belong to open documents and carry their undo
 * history. A preview is a throwaway view of something that already happened.
 */
function VersionPreview({ content }: { content: Parameters<typeof createEditor>[0]['content'] }) {
  const [editor, setEditor] = useState<Editor | null>(null)

  useEffect(() => {
    const instance = createEditor({
      content,
      getStyles: () => useProjectStore.getState().project?.manifest.styles ?? [],
      getEntities: () => useEntityStore.getState().entities,
      onUpdate: () => {}
    })
    instance.setEditable(false)
    setEditor(instance)
    return () => {
      setEditor(null)
      instance.destroy()
    }
  }, [content])

  if (!editor) return null
  return (
    <div className="p-3" data-testid="history-version">
      <div className="pub-sheet pub-sheet-preview">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}

/** A timestamp as an author reads one: how long ago, then the clock time. */
function when(timestamp: string): string {
  const at = Date.parse(timestamp)
  if (Number.isNaN(at)) return timestamp
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return new Date(at).toLocaleString()
}

function sizeOf(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} kB`
}
