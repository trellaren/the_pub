import { useEffect, useMemo, useState } from 'react'
import type { Highlight } from '@shared/model/highlight.js'
import type { PdfHighlight, ResearchAttachment } from '@shared/model/research.js'
import type { HighlightCategoryDef } from '@shared/model/manifest.js'
import { describeSource } from '@shared/model/source.js'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import { useHighlightStore } from '@renderer/stores/highlightStore.js'
import { useResearchStore } from '@renderer/stores/researchStore.js'
import { useSourceStore } from '@renderer/stores/sourceStore.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { revealBlock } from '../editor/editorActions.js'
import { citeFromPdfHighlight, citationPlacement, refreshCitations } from '../editor/citationActions.js'
import { PdfViewer } from './PdfViewer.js'
import { CaptureViewer } from './CaptureViewer.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton, TextInput, Select } from '@renderer/ui/primitives.js'

const NO_CATEGORIES: HighlightCategoryDef[] = []
const NO_HIGHLIGHTS: Highlight[] = []

/**
 * Highlights collected across the writer's own documents (Manuscript tab)
 * and inside research attachments — currently PDFs (Sources tab). See
 * `docs/phase-11-plan.md` Part 3.
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
  const highlights = useHighlightStore((store) =>
    docId ? (store.highlightsByDoc[docId] ?? NO_HIGHLIGHTS) : NO_HIGHLIGHTS
  )
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
        <SourcesTab docId={docId} />
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

/**
 * Highlights made inside research attachments — PDFs and web captures alike
 * — grouped by source and searchable over `quote`/`note` — the Manuscript
 * tab's UX, against `pdfHighlightService` instead of `highlightService`.
 * Clicking a highlight opens its attachment (a PDF at the right page, a
 * capture just opens); the reader's own "Cite" action inserts a citation
 * into whichever document last had focus. One unified list rather than a
 * PDF list and a capture list — a highlight is a highlight regardless of
 * which kind of attachment it lives in.
 */
function SourcesTab({ docId }: { docId: string | null }) {
  const sources = useSourceStore((store) => store.sources)
  const loadSources = useSourceStore((store) => store.load)
  const attachmentsBySource = useResearchStore((store) => store.attachmentsBySource)
  const loadAttachments = useResearchStore((store) => store.loadAttachments)
  const highlightsByAttachment = useResearchStore((store) => store.highlightsByAttachment)
  const loadHighlights = useResearchStore((store) => store.loadHighlights)
  const styleId = useProjectStore(
    (store) => store.project?.manifest.settings.citationStyleId ?? 'chicago-author-date'
  )
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<{ sourceId: string; attachmentId: string; kind: 'pdf' | 'capture'; page?: number } | null>(
    null
  )

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  const highlightableSources = sources.filter((source) =>
    (attachmentsBySource[source.id] ?? []).some(
      (attachment) => attachment.kind === 'pdf' || attachment.kind === 'capture'
    )
  )

  useEffect(() => {
    for (const source of sources) void loadAttachments(source.id)
  }, [sources, loadAttachments])

  useEffect(() => {
    for (const source of highlightableSources) {
      for (const attachment of attachmentsBySource[source.id] ?? []) {
        void loadHighlights(source.id, attachment.id)
      }
    }
    // highlightableSources is derived from attachmentsBySource each render;
    // only the underlying data need be watched, not the derived array's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentsBySource, loadHighlights])

  const rows: { source: CslItemLike; attachment: ResearchAttachment; highlight: PdfHighlight }[] = []
  for (const source of highlightableSources) {
    for (const attachment of attachmentsBySource[source.id] ?? []) {
      if (attachment.kind !== 'pdf' && attachment.kind !== 'capture') continue
      const highlights = highlightsByAttachment[`${source.id}/${attachment.id}`] ?? []
      for (const highlight of highlights) {
        rows.push({ source, attachment, highlight })
      }
    }
  }

  const needle = query.trim().toLowerCase()
  const filtered = rows.filter(
    (row) =>
      !needle ||
      row.highlight.quote.toLowerCase().includes(needle) ||
      row.highlight.note.toLowerCase().includes(needle)
  )
  const active = filtered.filter((row) => !row.highlight.orphaned)
  const orphaned = filtered.filter((row) => row.highlight.orphaned)

  const cite = async (sourceId: string, highlight: PdfHighlight) => {
    const editor = docId ? getEditor(docId) : null
    if (!editor) return
    const placement = await citationPlacement(styleId)
    citeFromPdfHighlight(editor, sourceId, highlight, placement, { includeQuote: true })
    await refreshCitations(editor, sources, styleId)
  }

  if (open) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-1 border-b border-border p-1">
          <ToolbarButton label="Back to list" onClick={() => setOpen(null)}>
            ← Back
          </ToolbarButton>
        </div>
        {open.kind === 'pdf' ? (
          <PdfViewer
            sourceId={open.sourceId}
            attachmentId={open.attachmentId}
            initialPage={open.page}
            onCite={(highlight) => void cite(open.sourceId, highlight)}
          />
        ) : (
          <CaptureViewer
            sourceId={open.sourceId}
            attachmentId={open.attachmentId}
            onCite={(highlight) => void cite(open.sourceId, highlight)}
          />
        )}
      </div>
    )
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border p-1">
        <TextInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search quote or note"
          className="flex-1"
        />
      </div>
      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <EmptyState
            title="No highlights yet"
            hint="Attach a PDF or web capture to a source in the Sources panel, open it, and select text to highlight."
          />
        ) : (
          <>
            {active.map((row) => (
              <SourceHighlightCard
                key={row.highlight.id}
                row={row}
                onOpen={() => setOpen({ sourceId: row.source.id, attachmentId: row.attachment.id, kind: row.attachment.kind as 'pdf' | 'capture', page: row.highlight.page })}
                onCite={() => void cite(row.source.id, row.highlight)}
              />
            ))}
            {orphaned.length > 0 ? (
              <div className="border-t border-border/60 p-2">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">Orphaned</p>
                {orphaned.map((row) => (
                  <SourceHighlightCard
                    key={row.highlight.id}
                    row={row}
                    onOpen={() => setOpen({ sourceId: row.source.id, attachmentId: row.attachment.id, kind: row.attachment.kind as 'pdf' | 'capture', page: row.highlight.page })}
                    onCite={() => void cite(row.source.id, row.highlight)}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}

type CslItemLike = { id: string } & Record<string, unknown>

function SourceHighlightCard({
  row,
  onOpen,
  onCite
}: {
  row: { source: CslItemLike; attachment: ResearchAttachment; highlight: PdfHighlight }
  onOpen: () => void
  onCite: () => void
}) {
  const removeHighlight = useResearchStore((store) => store.removeHighlight)
  return (
    <div className="border-b border-border/60 p-2">
      <div className="flex items-start gap-1">
        <span
          className="mt-0.5 h-3 w-3 shrink-0 rounded-sm border border-border"
          style={{ background: row.highlight.color }}
        />
        <button
          type="button"
          onClick={onOpen}
          className="flex-1 truncate text-left text-[12px] italic text-muted hover:text-text"
          title={row.highlight.quote}
        >
          “{row.highlight.quote}” — p.{row.highlight.page}
        </button>
        <ToolbarButton label="Cite this highlight" onClick={onCite}>
          Cite
        </ToolbarButton>
        <ToolbarButton
          label="Delete highlight"
          onClick={() => void removeHighlight(row.source.id, row.attachment.id, row.highlight.id)}
        >
          ✕
        </ToolbarButton>
      </div>
      <p className="mt-0.5 truncate text-[11px] text-faint">
        {describeSource(row.source as never)} · {row.attachment.label || row.attachment.title}
      </p>
      {row.highlight.orphaned ? (
        <p className="my-1 rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-faint">
          This highlight's text could not be found on any page.
        </p>
      ) : null}
    </div>
  )
}
