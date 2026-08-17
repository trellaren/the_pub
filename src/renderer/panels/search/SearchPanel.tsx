import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SearchHit, IndexProgress } from '@shared/model/search.js'
import { SEARCH_DEBOUNCE_MS } from '@shared/constants.js'
import { invoke, on } from '@renderer/lib/ipc.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { openLocation } from '@renderer/lib/openLocation.js'
import { Snippet } from '@renderer/ui/Snippet.js'
import {
  PanelShell,
  PanelHeader,
  EmptyState,
  LiveRegion,
  TextInput,
  ToolbarButton
} from '@renderer/ui/primitives.js'

/** Project-wide search over document text and filenames. */
export function SearchPanel() {
  const project = useProjectStore((store) => store.project)
  const [term, setTerm] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [progress, setProgress] = useState<IndexProgress | null>(null)
  const [searching, setSearching] = useState(false)
  const [resultAnnouncement, setResultAnnouncement] = useState('')
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
      setResultAnnouncement('')
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
        setResultAnnouncement(`${results.length} result${results.length === 1 ? '' : 's'} for ${term}`)
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term, matchCase, wholeWord, project])

  const openHit = useCallback(
    async (hit: SearchHit) => {
      await openLocation({
        path: hit.path,
        title: hit.title,
        blockIndex: hit.blockIndex,
        term: hit.kind === 'content' ? term : undefined
      })
    },
    [term]
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

      <LiveRegion text={resultAnnouncement} testId="search-result-live" />

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
                  {hit.kind === 'filename' ? (
                    <span className="italic text-faint">filename match</span>
                  ) : (
                    <Snippet hit={hit} />
                  )}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </PanelShell>
  )
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
