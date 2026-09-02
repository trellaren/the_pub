import { useEffect, useRef, useState } from 'react'
import { EditorContent } from '@tiptap/react'
import type { IDockviewPanelProps } from 'dockview-react'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { registerCommand } from '@renderer/commands/registry.js'
import { PanelShell, EmptyState, LiveRegion, cx } from '@renderer/ui/primitives.js'
import { RichToolbar } from './RichToolbar.js'
import { FindReplaceBar } from './FindReplaceBar.js'
import { EndnotesRegion } from './EndnotesRegion.js'
import { wordCount } from './editorActions.js'
import { useStatsStore } from '@renderer/stores/statsStore.js'
import { localDayKey } from '@renderer/stats/session.js'
import { refreshCitations, insertOrRefreshBibliography } from './citationActions.js'
import { currentSources } from '@renderer/stores/sourceStore.js'
import { DiffView } from '../history/DiffView.js'
import { invoke } from '@renderer/lib/ipc.js'
import type { PmDoc } from '@shared/model/document.js'

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
  // Selected as the string rather than off `settings`, whose object identity
  // changes on every manifest write — including each keystroke in Settings.
  const citationStyleId = useProjectStore((store) => store.project?.manifest.settings.citationStyleId)
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

  /*
   * Re-render this document's citations when the project's citation style
   * changes.
   *
   * The only automatic trigger. Editing a source stays manual, matching how a
   * moved heading does not retitle a cross-reference until this document's own
   * refresh is asked for — but a style is a project-wide switch, and one that
   * appeared to do nothing until every open document was visited and a toolbar
   * button pressed would simply read as broken.
   *
   * The ref makes this a change-only effect: firing on mount would refresh on
   * document open, which is the behaviour deliberately not wanted here.
   */
  const lastCitationStyle = useRef(citationStyleId)
  useEffect(() => {
    if (lastCitationStyle.current === citationStyleId) return
    lastCitationStyle.current = citationStyleId
    if (!citationStyleId) return
    const target = getEditor(docId)
    if (!target) return
    void (async () => {
      const sources = currentSources()
      const engine = await refreshCitations(target, sources, citationStyleId)
      if (engine) insertOrRefreshBibliography(target, sources, engine)
    })()
  }, [citationStyleId, docId])

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
  const sheetHeight = settings?.pageHeight ?? 792
  // The sheet honours all four margins, so what is on screen is the shape of
  // the page that prints.
  const sheetPadding = settings
    ? `${settings.pageMarginTop}pt ${settings.pageMarginRight}pt ${settings.pageMarginBottom}pt ${settings.pageMarginLeft}pt`
    : '72pt'

  return (
    <PanelShell>
      <RichToolbar editor={editor} docId={docId} />
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
          style={{
            width: `${sheetWidth}pt`,
            maxWidth: '100%',
            padding: sheetPadding,
            // A fresh document is a page, not a strip the height of its one
            // paragraph — the sheet holds the project's page height and grows
            // past it, so there is always somewhere to write *into*.
            minHeight: `${sheetHeight}pt`
          }}
          onClick={(event) => {
            // The blank expanse below the prose is still the page: clicking it
            // puts the cursor at the end, instead of doing visibly nothing.
            if (event.target === event.currentTarget) editor.chain().focus('end').run()
          }}
        >
          <EditorContent editor={editor} />
        </div>
        <EndnotesRegion editor={editor} width={`${sheetWidth}pt`} />
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
        This file was written by a newer version of Quoth. It's open read-only until you
        upgrade — your changes are kept here, but nothing can be saved.
      </span>
    </div>
  )
}

function ConflictBar({ docId }: { docId: string }) {
  const keepMine = useDocumentStore((store) => store.keepMine)
  const reload = useDocumentStore((store) => store.reload)
  const path = useDocumentStore((store) => store.docs[docId]?.path ?? '')
  const [theirs, setTheirs] = useState<PmDoc | null>(null)

  /**
   * "Keep mine" and "reload" are both destructive, and asking someone to pick
   * one blind is asking them to guess. The comparison is the same block diff
   * history already shows, against the file as it now stands on disk.
   */
  const compare = async (): Promise<void> => {
    const loaded = await invoke('doc:read', { path }).catch(() => null)
    if (loaded) setTheirs(loaded.doc.content)
  }

  const editor = getEditor(docId)
  return (
    <div className="shrink-0 border-b border-danger/40 bg-danger/10">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
        <span className="flex-1 text-danger">
          This file changed outside Quoth. Your unsaved edits are still here.
        </span>
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 hover:bg-surface-3"
          onClick={() => (theirs ? setTheirs(null) : void compare())}
        >
          {theirs ? 'Hide changes' : 'See what changed'}
        </button>
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
      {theirs && editor ? (
        <div className="max-h-64 overflow-auto border-t border-danger/40 bg-bg">
          <DiffView before={theirs} after={editor.getJSON() as PmDoc} />
        </div>
      ) : null}
    </div>
  )
}

function StatusBar({ docId }: { docId: string }) {
  const state = useDocumentStore((store) => store.docs[docId])
  const [words, setWords] = useState(0)
  const editor = getEditor(docId)
  const goals = useProjectStore((store) => store.project?.manifest.goals)
  const todayStat = useStatsStore((store) => store.days.find((day) => day.date === localDayKey(new Date())))
  const [savedAnnouncement, setSavedAnnouncement] = useState('')
  const wasSaving = useRef(false)

  // Announced once per save, on the saving->saved transition — not on every
  // keystroke's dirty flag, which would be read aloud constantly.
  useEffect(() => {
    if (wasSaving.current && !state?.saving) setSavedAnnouncement(`Saved at ${new Date().toLocaleTimeString()}`)
    wasSaving.current = Boolean(state?.saving)
  }, [state?.saving])

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
      <LiveRegion text={savedAnnouncement} testId="save-state-live" />
      <span className="truncate" title={state.path}>
        {state.path}
      </span>
      <span className="flex-1" />
      <span className={cx(state.saving && 'text-accent')}>
        {state.saving ? 'Saving…' : state.dirty ? 'Unsaved' : 'Saved'}
      </span>
      <span className="tabular-nums">{words.toLocaleString()} words</span>
      {goals && goals.dailyTarget > 0 ? (
        <span className="tabular-nums text-faint" title="Today's writing, against the daily target">
          {todayStat?.added ?? 0} / {goals.dailyTarget} today
        </span>
      ) : null}
    </div>
  )
}
