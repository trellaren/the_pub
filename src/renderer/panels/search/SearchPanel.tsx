import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SearchHit, IndexProgress } from '@shared/model/search.js'
import { SEARCH_DEBOUNCE_MS } from '@shared/constants.js'
import { invoke, on } from '@renderer/lib/ipc.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import { useLayoutStore } from '@renderer/stores/layoutStore.js'
import { revealBlock } from '@renderer/panels/editor/editorActions.js'
import { PanelShell, PanelHeader, EmptyState, TextInput, ToolbarButton, cx } from '@renderer/ui/primitives.js'

/** Project-wide search over document text and filenames. */
export function SearchPanel() {
  const project = useProjectStore((store) => store.project)
  const openPath = useDocumentStore((store) => store.openPath)
  const openEditor = useLayoutStore((store) => store.openEditor)
  const [term, setTerm] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [progress, setProgress] = useState<IndexProgress | null>(null)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestId = useRef(0)

  useEffect(() => {
    return on('search:indexProgress', setProgress)
  }, [])

  useEffect(() => {
    if (!project) return
    void invoke('search:status', {}).then(setProgress).catch(() => {})
  }, [project])

  useEffect(() => {
    if (!term.trim()) {
      setHits([])
      return
    }
    setSearching(true)
    const id = ++requestId.current
    const timer = setTimeout(async () => {
      const results = await invoke('search:query', {
        text: term,
        limit: 200,
        matchCase,
        wholeWord
      }).catch(() => [])
      // A slower earlier query must not overwrite the newest results.
      if (id === requestId.current) {
        setHits(results)
        setSearching(false)
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term, matchCase, wholeWord, project])

  const openHit = useCallback(
    async (hit: SearchHit) => {
      const docId = await openPath(hit.path)
      if (!docId) return
      const state = useDocumentStore.getState().docs[docId]
      openEditor(docId, hit.path, state?.title ?? hit.title)
      // The editor may have only just been created; let it mount before scrolling.
      requestAnimationFrame(() => {
        const editor = getEditor(docId)
        if (editor) revealBlock(editor, hit.blockIndex, hit.kind === 'content' ? term : undefined)
      })
    },
    [openPath, openEditor, term]
  )

  const grouped = useMemo(() => groupByFile(hits), [hits])

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>Search</PanelHeader>
        <EmptyState title="No project open" />
      </PanelShell>
    )
  }

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1">Search</span>
        <ToolbarButton label="Rebuild index" onClick={() => void invoke('search:reindex', {})}>
          ⟳
        </ToolbarButton>
      </PanelHeader>

      <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
        <TextInput
          ref={inputRef}
          value={term}
          placeholder="Search project"
          onChange={(event) => setTerm(event.target.value)}
          data-testid="search-input"
        />
        <ToolbarButton label="Match case" active={matchCase} onClick={() => setMatchCase((on) => !on)}>
          Aa
        </ToolbarButton>
        <ToolbarButton label="Whole word" active={wholeWord} onClick={() => setWholeWord((on) => !on)}>
          ab
        </ToolbarButton>
      </div>

      {progress?.indexing ? (
        <div className="border-b border-border px-2 py-1 text-[11px] text-faint">
          Indexing {progress.done}/{progress.total}…
        </div>
      ) : null}

      <div className="flex-1 overflow-auto">
        {term.trim() === '' ? (
          <EmptyState title="Search across every document" hint="Results link straight to the paragraph." />
        ) : hits.length === 0 ? (
          <EmptyState title={searching ? 'Searching…' : 'No matches'} />
        ) : (
          grouped.map(([path, fileHits]) => (
            <div key={path} className="border-b border-border/60 py-1">
              <div className="truncate px-2 py-1 text-[11px] font-medium text-muted" title={path}>
                {path}
                <span className="ml-1 text-faint">{fileHits.length}</span>
              </div>
              {fileHits.map((hit, index) => (
                <button
                  key={`${hit.docId}-${hit.blockIndex}-${index}`}
                  type="button"
                  onClick={() => void openHit(hit)}
                  className="block w-full px-2 py-1 pl-4 text-left text-[12px] text-muted hover:bg-surface-2 hover:text-text"
                >
                  <Snippet hit={hit} />
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </PanelShell>
  )
}

function Snippet({ hit }: { hit: SearchHit }) {
  if (hit.kind === 'filename') {
    return <span className="italic text-faint">filename match</span>
  }
  if (hit.ranges.length === 0) return <span className="line-clamp-2">{hit.snippet}</span>

  const parts: ReactNode[] = []
  let cursor = 0
  hit.ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(hit.snippet.slice(cursor, range.start))
    parts.push(
      <mark key={index} className="rounded-sm bg-accent-soft px-0.5 text-accent">
        {hit.snippet.slice(range.start, range.end)}
      </mark>
    )
    cursor = range.end
  })
  if (cursor < hit.snippet.length) parts.push(hit.snippet.slice(cursor))
  return <span className={cx('line-clamp-2')}>{parts}</span>
}

function groupByFile(hits: SearchHit[]): [string, SearchHit[]][] {
  const groups = new Map<string, SearchHit[]>()
  for (const hit of hits) {
    const existing = groups.get(hit.path)
    if (existing) existing.push(hit)
    else groups.set(hit.path, [hit])
  }
  return [...groups.entries()]
}
