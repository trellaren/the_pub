import { useEffect, useMemo, useRef, useState } from 'react'
import { listCommands, runCommand, type Command } from './registry.js'
import { matchDocuments, type DocumentCandidate } from './quickOpen.js'
import { attempt, invoke } from '@renderer/lib/ipc.js'
import { useDocumentStore } from '@renderer/stores/documentStore.js'
import { useLayoutStore } from '@renderer/stores/layoutStore.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { cx } from '@renderer/ui/primitives.js'
import { useModalFocusTrap } from '@renderer/ui/useModalFocusTrap.js'

interface Entry {
  id: string
  label: string
  detail?: string
  run: () => void
}

/** Command palette, quick-open and the panel picker, sharing one list UI. */
export function CommandPalette({
  mode,
  onClose
}: {
  mode: 'commands' | 'files' | 'panels'
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [documents, setDocuments] = useState<DocumentCandidate[] | null>(null)
  const [index, setIndex] = useState(0)
  const project = useProjectStore((store) => store.project)
  const dialogRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // The trap re-arms whenever its callback changes, and re-arming re-reads
  // which element to give focus back to — by then, the palette's own input.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [closeOnEscape] = useState(() => () => onCloseRef.current())
  useModalFocusTrap(dialogRef, closeOnEscape)

  const commandEntries = useMemo<Entry[]>(
    () =>
      listCommands().map((command: Command) => ({
        id: command.id,
        label: command.title,
        detail: command.id,
        run: () => runCommand(command.id)
      })),
    []
  )

  // The dock's currently open panels — "Focus panel…"'s list. Read fresh each
  // time the palette opens in this mode rather than subscribed, since which
  // panels are open does not change while the picker itself is up.
  const panelEntries = useMemo<Entry[]>(() => {
    if (mode !== 'panels') return []
    return useLayoutStore
      .getState()
      .listOpenPanels()
      .map((panel) => ({
        id: panel.id,
        label: panel.title,
        run: () => useLayoutStore.getState().focusPanelById(panel.id)
      }))
  }, [mode])

  // Every document in the project, walked once per opening: the search index
  // only finds documents by their words, so a chapter titled "Storm" whose
  // text never says it was unreachable by name.
  useEffect(() => {
    if (mode !== 'files' || !project) return
    let cancelled = false
    void attempt(invoke('manuscript:candidates', {}), 'Could not list documents').then((found) => {
      if (!cancelled) setDocuments(found ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [mode, project?.uri])

  const entries = useMemo<Entry[]>(() => {
    if (mode === 'files') {
      if (!project) {
        return [{ id: 'project.open', label: 'Open a project…', run: () => runCommand('project.open') }]
      }
      return matchDocuments(documents ?? [], query).map((doc) => ({
        id: doc.docId || doc.path,
        label: doc.title || doc.path,
        detail: doc.path,
        run: () => void openDocument(doc.path, doc.title)
      }))
    }
    const source = mode === 'panels' ? panelEntries : commandEntries
    const needle = query.trim().toLowerCase()
    if (!needle) return source
    return source.filter((entry) => entry.label.toLowerCase().includes(needle))
  }, [mode, query, project, commandEntries, documents, panelEntries])

  useEffect(() => setIndex(0), [query, mode])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index, entries])

  const choose = (entry: Entry): void => {
    onClose()
    // After the palette has unmounted and handed focus back, so a command that
    // moves focus itself — a dialog, a newly opened editor — keeps it.
    setTimeout(entry.run, 0)
  }

  const listId = `palette-list-${mode}`
  const optionId = (entryIndex: number): string => `${listId}-${entryIndex}`
  const loading = mode === 'files' && project !== null && documents === null
  const label = mode === 'files' ? 'Go to document' : mode === 'panels' ? 'Focus panel' : 'Command palette'

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-24"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="w-[560px] max-w-[90vw] overflow-hidden rounded-lg border border-border bg-surface-2 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={entries[index] ? optionId(index) : undefined}
          aria-label={label}
          placeholder={
            mode === 'files' ? 'Go to document…' : mode === 'panels' ? 'Focus which panel?' : 'Type a command…'
          }
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setIndex((current) => Math.min(current + 1, entries.length - 1))
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setIndex((current) => Math.max(current - 1, 0))
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              const entry = entries[index]
              if (entry) choose(entry)
            }
          }}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-[14px] text-text outline-none placeholder:text-faint"
        />
        <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="max-h-80 overflow-auto py-1">
          {entries.length === 0 ? (
            <li role="presentation" className="px-4 py-3 text-[12px] text-faint">
              {loading ? 'Loading…' : 'No matches'}
            </li>
          ) : (
            entries.map((entry, entryIndex) => (
              <li
                key={entry.id}
                id={optionId(entryIndex)}
                data-index={entryIndex}
                role="option"
                aria-selected={entryIndex === index}
                onMouseEnter={() => setIndex(entryIndex)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(entry)}
                className={cx(
                  'flex w-full cursor-pointer items-baseline gap-2 px-4 py-1.5 text-left text-[13px]',
                  entryIndex === index ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2'
                )}
              >
                <span className="truncate">{entry.label}</span>
                {entry.detail ? (
                  <span className="ml-auto truncate text-[11px] text-faint">{entry.detail}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}

async function openDocument(path: string, title: string): Promise<void> {
  const docId = await useDocumentStore.getState().openPath(path)
  if (!docId) return
  const state = useDocumentStore.getState().docs[docId]
  useLayoutStore.getState().openEditor(docId, path, state?.title ?? title)
}
