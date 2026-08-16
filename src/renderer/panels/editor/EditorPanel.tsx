import { useEffect, useState } from 'react'
import { EditorContent } from '@tiptap/react'
import type { IDockviewPanelProps } from 'dockview-react'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { registerCommand } from '@renderer/commands/registry.js'
import { PanelShell, EmptyState, cx } from '@renderer/ui/primitives.js'
import { RichToolbar } from './RichToolbar.js'
import { FindReplaceBar } from './FindReplaceBar.js'
import { wordCount } from './editorActions.js'

export interface EditorPanelParams {
  docId: string
  path: string
}

/**
 * One open document.
 *
 * The editor instance itself is owned by the document store, not by this
 * component — so dragging the tab into another group or out into its own window
 * re-mounts the panel without disturbing the document's history or selection.
 */
export function EditorPanel(props: IDockviewPanelProps<EditorPanelParams>) {
  const { docId } = props.params
  const state = useDocumentStore((store) => store.docs[docId])
  const setActive = useDocumentStore((store) => store.setActive)
  const openDocId = useDocumentStore((store) => store.openDocId)
  const settings = useProjectStore((store) => store.project?.manifest.settings)
  const [find, setFindBar] = useState<'hidden' | 'find' | 'replace'>('hidden')
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed'>('idle')

  // A layout restored on startup references documents by id; open whatever this
  // panel points at if it isn't loaded yet. One attempt only — retrying on
  // failure would spin forever on a document that no longer exists.
  useEffect(() => {
    if (state || status !== 'idle') return
    setStatus('loading')
    void openDocId(docId, props.params.path).then((opened) => setStatus(opened ? 'idle' : 'failed'))
  }, [state, status, docId, props.params.path, openDocId])

  useEffect(() => {
    const disposable = props.api.onDidActiveChange(({ isActive }) => {
      if (isActive) setActive(docId)
    })
    if (props.api.isActive) setActive(docId)
    return () => disposable.dispose()
  }, [props.api, docId, setActive])

  // Reflect unsaved state in the tab, the way an IDE does.
  useEffect(() => {
    if (!state) return
    props.api.setTitle(`${state.dirty ? '● ' : ''}${state.title}`)
  }, [props.api, state?.dirty, state?.title, state])

  useEffect(() => {
    return registerCommand({
      id: 'editor.find',
      title: 'Find in Document',
      run: () => setFindBar('find'),
      isEnabled: () => props.api.isActive
    })
  }, [props.api])

  useEffect(() => {
    return registerCommand({
      id: 'editor.replace',
      title: 'Replace in Document',
      run: () => setFindBar('replace'),
      isEnabled: () => props.api.isActive
    })
  }, [props.api])

  const editor = getEditor(docId)

  // Typing must actually stop, not just fail to save — otherwise the buffer
  // keeps growing further from what's safe to write, with no way to persist
  // any of it.
  useEffect(() => {
    editor?.setEditable(!state?.tooNew)
  }, [editor, state?.tooNew])

  if (!state || !editor) {
    return (
      <PanelShell>
        <EmptyState
          title={status === 'failed' ? 'This document could not be opened' : 'Opening…'}
          hint={status === 'failed' ? props.params.path : undefined}
        />
      </PanelShell>
    )
  }

  if (state.missing) {
    return (
      <PanelShell>
        <EmptyState title="This file no longer exists" hint={state.path} />
      </PanelShell>
    )
  }

  const sheetWidth = settings?.pageWidth ?? 612
  const sheetPadding = settings?.pageMargin ?? 72

  return (
    <PanelShell>
      <RichToolbar editor={editor} />
      {find !== 'hidden' ? (
        <FindReplaceBar
          editor={editor}
          showReplace={find === 'replace'}
          onClose={() => {
            setFindBar('hidden')
            editor.commands.focus()
          }}
        />
      ) : null}
      {state.conflict ? <ConflictBar docId={docId} /> : null}
      {state.tooNew ? <TooNewBar /> : null}

      <div className="flex-1 overflow-auto bg-bg" onMouseDown={() => setActive(docId)}>
        <div
          className="pub-sheet"
          style={{ width: `${sheetWidth}pt`, maxWidth: '100%', padding: `${sheetPadding}pt` }}
        >
          <EditorContent editor={editor} />
        </div>
      </div>

      <StatusBar docId={docId} />
    </PanelShell>
  )
}

/** No keep-mine/reload choice here, unlike `ConflictBar` — overwriting is exactly what must not happen. */
function TooNewBar() {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[12px]">
      <span className="flex-1 text-danger">
        This file was written by a newer version of The Pub. It's open read-only until you
        upgrade — your changes are kept here, but nothing can be saved.
      </span>
    </div>
  )
}

function ConflictBar({ docId }: { docId: string }) {
  const keepMine = useDocumentStore((store) => store.keepMine)
  const reload = useDocumentStore((store) => store.reload)
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[12px]">
      <span className="flex-1 text-danger">
        This file changed outside The Pub. Your unsaved edits are still here.
      </span>
      <button
        type="button"
        className="rounded border border-border px-2 py-0.5 hover:bg-surface-3"
        onClick={() => void reload(docId)}
      >
        Discard mine, reload
      </button>
      <button
        type="button"
        className="rounded border border-accent bg-accent-soft px-2 py-0.5 text-accent"
        onClick={() => void keepMine(docId)}
      >
        Keep mine, overwrite
      </button>
    </div>
  )
}

function StatusBar({ docId }: { docId: string }) {
  const state = useDocumentStore((store) => store.docs[docId])
  const [words, setWords] = useState(0)
  const editor = getEditor(docId)

  useEffect(() => {
    if (!editor) return
    const update = (): void => setWords(wordCount(editor))
    update()
    editor.on('update', update)
    return () => {
      editor.off('update', update)
    }
  }, [editor])

  if (!state) return null

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-[11px] text-faint">
      <span className="truncate" title={state.path}>
        {state.path}
      </span>
      <span className="flex-1" />
      <span className={cx(state.saving && 'text-accent')}>
        {state.saving ? 'Saving…' : state.dirty ? 'Unsaved' : 'Saved'}
      </span>
      <span className="tabular-nums">{words.toLocaleString()} words</span>
    </div>
  )
}
