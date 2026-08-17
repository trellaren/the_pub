import { useEffect, useMemo, useState } from 'react'
import { listCommands, runCommand, type Command } from './registry.js'
import { invoke } from '@renderer/lib/ipc.js'
import { useDocumentStore } from '@renderer/stores/documentStore.js'
import { useLayoutStore } from '@renderer/stores/layoutStore.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { cx } from '@renderer/ui/primitives.js'

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
  const [fileEntries, setFileEntries] = useState<Entry[]>([])
  const [index, setIndex] = useState(0)
  const project = useProjectStore((store) => store.project)

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

  // Quick-open reuses the search index rather than walking the tree, so it stays
  // fast on a large project and matches what search already knows about.
  useEffect(() => {
    if (mode !== 'files' || !project) return
    let cancelled = false
    void (async () => {
      const hits = await invoke('search:query', {
        text: query.trim() || 'a',
        limit: 60,
        matchCase: false,
        wholeWord: false
      }).catch(() => [])
      if (cancelled) return
      const seen = new Set<string>()
      const entries: Entry[] = []
      for (const hit of hits) {
        if (seen.has(hit.docId)) continue
        seen.add(hit.docId)
        entries.push({
          id: hit.docId,
          label: hit.title,
          detail: hit.path,
          run: () => void openDocument(hit.path, hit.docId, hit.title)
        })
      }
      setFileEntries(entries)
    })()
    return () => {
      cancelled = true
    }
  }, [mode, query, project])

  const entries = useMemo(() => {
    if (mode === 'files') return fileEntries
    const source = mode === 'panels' ? panelEntries : commandEntries
    const needle = query.trim().toLowerCase()
    if (!needle) return source
    return source.filter((entry) => entry.label.toLowerCase().includes(needle))
  }, [mode, query, commandEntries, fileEntries, panelEntries])

  useEffect(() => setIndex(0), [query, mode])

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-24"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] overflow-hidden rounded-lg border border-border bg-surface-2 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          placeholder={
            mode === 'files' ? 'Go to document…' : mode === 'panels' ? 'Focus which panel?' : 'Type a command…'
          }
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
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
              if (entry) {
                onClose()
                entry.run()
              }
            }
          }}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-[14px] text-text outline-none placeholder:text-faint"
        />
        <ul className="max-h-80 overflow-auto py-1">
          {entries.length === 0 ? (
            <li className="px-4 py-3 text-[12px] text-faint">No matches</li>
          ) : (
            entries.map((entry, entryIndex) => (
              <li key={`${entry.id}-${entryIndex}`}>
                <button
                  type="button"
                  onMouseEnter={() => setIndex(entryIndex)}
                  onClick={() => {
                    onClose()
                    entry.run()
                  }}
                  className={cx(
                    'flex w-full items-baseline gap-2 px-4 py-1.5 text-left text-[13px]',
                    entryIndex === index ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2'
                  )}
                >
                  <span className="truncate">{entry.label}</span>
                  {entry.detail ? (
                    <span className="ml-auto truncate text-[11px] text-faint">{entry.detail}</span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}

async function openDocument(path: string, _docId: string, title: string): Promise<void> {
  const docId = await useDocumentStore.getState().openPath(path)
  if (!docId) return
  const state = useDocumentStore.getState().docs[docId]
  useLayoutStore.getState().openEditor(docId, path, state?.title ?? title)
}
