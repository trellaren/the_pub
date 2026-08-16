import { useEffect, useMemo, useState } from 'react'
import { ulid } from 'ulid'
import type { Note } from '@shared/model/note.js'
import type { PmDoc } from '@shared/model/document.js'
import { findTextOccurrences, applyAnchorMark, type TextOccurrence } from '@shared/pm/anchors.js'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import { useNoteStore } from '@renderer/stores/noteStore.js'
import { revealBlock } from '../editor/editorActions.js'
import { NoteEditor } from './NoteEditor.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton, Checkbox } from '@renderer/ui/primitives.js'

const MAX_REATTACH_CANDIDATES = 5

/**
 * One shared empty array, never a fresh `[]` from the selector.
 *
 * zustand compares a selector's result by identity, so a selector that mints an
 * array on every call reports a change on every render — and React re-renders
 * forever, taking the whole window down with it. A document with no notes yet
 * is exactly the case that hits it, which is why every existing test missed it:
 * they all add a note before opening the panel.
 */
const NO_NOTES: Note[] = []

/**
 * Notes attached to the active document.
 *
 * Scoped to whichever editor last had focus, the same way `StatusBar` is —
 * not to whatever tab happens to be frontmost, since switching to a panel
 * like Search shouldn't blank this one out.
 */
export function NotesPanel() {
  const docId = useDocumentStore((store) => store.activeDocId)
  const notes = useNoteStore((store) => (docId ? (store.notesByDoc[docId] ?? NO_NOTES) : NO_NOTES))

  useEffect(() => {
    if (docId) void useNoteStore.getState().loadForDoc(docId)
  }, [docId])

  if (!docId) {
    return (
      <PanelShell>
        <PanelHeader>Notes</PanelHeader>
        <EmptyState title="Open a document to see its notes" />
      </PanelShell>
    )
  }

  const editor = getEditor(docId)
  const sorted = [...notes].sort((a, b) => a.blockIndex - b.blockIndex)

  return (
    <PanelShell>
      <PanelHeader>Notes</PanelHeader>
      <div className="flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <EmptyState title="No notes yet" hint="Select some text and add one from the toolbar." />
        ) : (
          sorted.map((note) => <NoteCard key={note.id} docId={docId} note={note} editor={editor ?? null} />)
        )}
      </div>
    </PanelShell>
  )
}

function NoteCard({
  docId,
  note,
  editor
}: {
  docId: string
  note: Note
  editor: ReturnType<typeof getEditor> | null
}) {
  const patch = useNoteStore((store) => store.patch)
  const remove = useNoteStore((store) => store.remove)

  // Re-attach candidates depend on the document's live content, which the
  // editor mutates in place — its object identity never changes, so without
  // this a candidate list computed once while orphaned would never notice
  // the very edit that brought the anchored text back.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!editor || !note.orphaned) return
    const bump = (): void => setTick((value) => value + 1)
    editor.on('transaction', bump)
    return () => {
      editor.off('transaction', bump)
    }
  }, [editor, note.orphaned])

  const candidates = useMemo(() => {
    if (!note.orphaned || !editor) return []
    return findTextOccurrences(editor.getJSON() as PmDoc, note.anchorText).slice(0, MAX_REATTACH_CANDIDATES)
  }, [note.orphaned, note.anchorText, editor, tick])

  const reattach = (occurrence: TextOccurrence): void => {
    if (!editor) return
    const anchorId = ulid()
    const current = editor.getJSON() as PmDoc
    const updated = applyAnchorMark(current, occurrence.blockIndex, occurrence.start, occurrence.end, anchorId)
    if (!updated) return
    editor.commands.setContent(updated)
    patch(docId, note.id, { anchorId, blockIndex: occurrence.blockIndex, orphaned: false })
  }

  return (
    <div className="border-b border-border/60 p-2">
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={() => editor && revealBlock(editor, note.blockIndex, note.anchorText)}
          disabled={!editor || note.orphaned}
          className="flex-1 truncate text-left text-[12px] italic text-muted hover:text-text disabled:hover:text-muted"
          title={note.anchorText}
        >
          “{note.anchorText}”
        </button>
        <ToolbarButton label="Delete note" onClick={() => void remove(docId, note.id)}>
          ✕
        </ToolbarButton>
      </div>

      {note.orphaned ? (
        <div className="my-1 rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-faint">
          <p>This note's text is no longer in the document.</p>
          {candidates.length === 0 ? (
            <p className="mt-1">No matching text found to re-attach it to.</p>
          ) : (
            <div className="mt-1 flex flex-col gap-1">
              {candidates.map((occurrence, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => reattach(occurrence)}
                  className="rounded border border-border px-1 py-0.5 text-left hover:bg-surface hover:text-text"
                >
                  Attach to occurrence in block {occurrence.blockIndex + 1}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <NoteEditor noteId={note.id} body={note.body} onChange={(body) => patch(docId, note.id, { body })} />

      <div className="mt-1">
        <Checkbox
          label="Resolved"
          checked={note.resolved}
          onChange={(checked) => patch(docId, note.id, { resolved: checked })}
        />
      </div>
    </div>
  )
}
