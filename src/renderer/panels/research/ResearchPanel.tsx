import { useEffect, useMemo, useState } from 'react'
import type { Highlight } from '@shared/model/highlight.js'
import type { HighlightCategoryDef } from '@shared/model/manifest.js'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import { useHighlightStore } from '@renderer/stores/highlightStore.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { revealBlock } from '../editor/editorActions.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton, TextInput, Select } from '@renderer/ui/primitives.js'

const NO_CATEGORIES: HighlightCategoryDef[] = []

/**
 * Highlights collected across the writer's own documents and, eventually,
 * research attachments. Phase 11 Part 3 ships the Manuscript tab against
 * `highlightService`; the Sources tab (PDF/web-capture highlights) is
 * deferred — see `docs/phase-11-plan.md` Part 2, not yet wired in.
 *
 * Scoped to the active document, the same way `NotesPanel` is: a highlight
 * belongs to whichever document last had focus, not to whatever tab happens
 * to be frontmost.
 */
export function ResearchPanel() {
  const [tab, setTab] = useState<'manuscript' | 'sources'>('manuscript')
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')

  const docId = useDocumentStore((store) => store.activeDocId)
  const highlights = useHighlightStore((store) => (docId ? (store.highlightsByDoc[docId] ?? []) : []))
  const categories = useProjectStore((store) => store.project?.manifest.highlightCategories) ?? NO_CATEGORIES

  useEffect(() => {
    if (docId) void useHighlightStore.getState().loadForDoc(docId)
  }, [docId])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return highlights
      .filter((highlight) => !categoryFilter || highlight.categoryId === categoryFilter)
      .filter(
        (highlight) =>
          !needle ||
          highlight.quote.toLowerCase().includes(needle) ||
          highlight.note.toLowerCase().includes(needle)
      )
      .sort((a, b) => a.blockIndex - b.blockIndex)
  }, [highlights, query, categoryFilter])

  const orphaned = filtered.filter((highlight) => highlight.orphaned)
  const active = filtered.filter((highlight) => !highlight.orphaned)

  return (
    <PanelShell>
      <PanelHeader>Research</PanelHeader>
      <div className="flex shrink-0 gap-0.5 border-b border-border px-2 pt-1">
        <button
          type="button"
          onClick={() => setTab('manuscript')}
          className={`rounded-t px-2 py-1 text-[12px] ${tab === 'manuscript' ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`}
        >
          Manuscript
        </button>
        <button
          type="button"
          onClick={() => setTab('sources')}
          className={`rounded-t px-2 py-1 text-[12px] ${tab === 'sources' ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`}
        >
          Sources
        </button>
      </div>

      {tab === 'sources' ? (
        <div className="flex-1 overflow-auto">
          <EmptyState
            title="Not available yet"
            hint="Highlights in research attachments (PDFs and web captures) are not wired up in this build."
          />
        </div>
      ) : !docId ? (
        <EmptyState title="Open a document to see its highlights" />
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1 border-b border-border p-1">
            <TextInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search quote or note"
              className="flex-1"
            />
            <Select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="w-28">
              <option value="">All categories</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex-1 overflow-auto">
            {filtered.length === 0 ? (
              <EmptyState
                title="No highlights yet"
                hint="Highlight text in the editor, then use Collect… in the toolbar."
              />
            ) : (
              <>
                {active.map((highlight) => (
                  <HighlightCard key={highlight.id} docId={docId} highlight={highlight} categories={categories} />
                ))}
                {orphaned.length > 0 ? (
                  <div className="border-t border-border/60 p-2">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">
                      Orphaned
                    </p>
                    {orphaned.map((highlight) => (
                      <HighlightCard key={highlight.id} docId={docId} highlight={highlight} categories={categories} />
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </PanelShell>
  )
}

function HighlightCard({
  docId,
  highlight,
  categories
}: {
  docId: string
  highlight: Highlight
  categories: HighlightCategoryDef[]
}) {
  const patch = useHighlightStore((store) => store.patch)
  const remove = useHighlightStore((store) => store.remove)
  const editor = getEditor(docId)
  const category = categories.find((candidate) => candidate.id === highlight.categoryId)

  return (
    <div className="border-b border-border/60 p-2">
      <div className="flex items-start gap-1">
        <span
          className="mt-0.5 h-3 w-3 shrink-0 rounded-sm border border-border"
          style={{ background: highlight.color }}
          title={category?.label ?? 'No category'}
        />
        <button
          type="button"
          onClick={() => editor && revealBlock(editor, highlight.blockIndex, highlight.quote)}
          disabled={!editor || highlight.orphaned}
          className="flex-1 truncate text-left text-[12px] italic text-muted hover:text-text disabled:hover:text-muted"
          title={highlight.quote}
        >
          “{highlight.quote}”
        </button>
        <ToolbarButton label="Delete highlight" onClick={() => void remove(docId, highlight.id)}>
          ✕
        </ToolbarButton>
      </div>

      {highlight.orphaned ? (
        <p className="my-1 rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-faint">
          This highlight's text is no longer in the document.
        </p>
      ) : null}

      <Select
        value={highlight.categoryId}
        onChange={(event) => patch(docId, highlight.id, { categoryId: event.target.value })}
        className="mt-1 w-full"
      >
        <option value="">No category</option>
        {categories.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.label}
          </option>
        ))}
      </Select>

      <TextInput
        value={highlight.note}
        onChange={(event) => patch(docId, highlight.id, { note: event.target.value })}
        placeholder="Note…"
        className="mt-1 w-full"
      />
    </div>
  )
}
