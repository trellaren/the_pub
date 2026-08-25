import { useEffect, useRef, useState } from 'react'
import type { CslItem, CslName } from '@shared/model/source.js'
import type { Capture, ResearchAttachment } from '@shared/model/research.js'
import { CSL_TYPES, describeSource, isProvisional } from '@shared/model/source.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useSourceStore } from '@renderer/stores/sourceStore.js'
import { useResearchStore } from '@renderer/stores/researchStore.js'
import { invoke, attempt, reportNotice } from '@renderer/lib/ipc.js'

/** Written to be shown verbatim: each failure calls for a different response. */
const LOOKUP_FAILURES: Record<string, string> = {
  'not-found': 'No record was found for that identifier.',
  offline: 'Could not reach the lookup service. Check your connection and try again.',
  malformed: 'The service answered with something this build could not read.',
  unsupported: 'That does not look like a DOI or an ISBN.'
}
import {
  PanelShell,
  PanelHeader,
  EmptyState,
  TextInput,
  ToolbarButton,
  Field,
  Select,
  cx
} from '@renderer/ui/primitives.js'

/**
 * The project's citable sources: a master/detail editor in `EntityPanel`'s
 * shape, over CSL-JSON instead of a story record.
 *
 * Only the fields most citations actually need are exposed — title, authors,
 * year, container, publisher, DOI/URL. `cslItemSchema`'s `.catchall` keeps
 * whatever else an import brought in (an editor, a volume, a page range)
 * intact on disk even though this form has nowhere to show it yet.
 */
export function SourcesPanel() {
  const project = useProjectStore((store) => store.project)
  const sources = useSourceStore((store) => store.sources)
  const patch = useSourceStore((store) => store.patch)
  const create = useSourceStore((store) => store.create)
  const remove = useSourceStore((store) => store.remove)
  const accept = useSourceStore((store) => store.accept)

  const load = useSourceStore((store) => store.load)

  const sorted = [...sources].sort((a, b) => describeSource(a).localeCompare(describeSource(b)))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [lookupText, setLookupText] = useState('')
  const [busy, setBusy] = useState(false)
  const selected = sorted.find((source) => source.id === selectedId) ?? sorted[0] ?? null

  const addSource = async (): Promise<void> => {
    const source = await create('book')
    if (source) setSelectedId(source.id)
  }

  /**
   * Both import paths reload the whole library rather than splicing the result
   * in: a merge can add *and* replace, and reproducing that arithmetic in the
   * store would be a second implementation of it to keep in step.
   */
  const importSources = async (): Promise<void> => {
    setBusy(true)
    const result = await attempt(invoke('sources:importDialog', {}), 'Could not import sources')
    setBusy(false)
    // Null is the file dialog being cancelled, which is not a failure.
    if (!result) return
    await load()
    for (const warning of result.warnings) reportNotice(warning)
    reportNotice(
      result.added + result.replaced === 0
        ? 'No sources were imported.'
        : `Imported ${result.added} new source${result.added === 1 ? '' : 's'}` +
            (result.replaced > 0 ? `, updating ${result.replaced}.` : '.')
    )
  }

  const lookUp = async (): Promise<void> => {
    const query = lookupText.trim()
    if (!query || busy) return
    setBusy(true)
    const result = await attempt(invoke('sources:lookup', { query }), 'Could not look that up')
    setBusy(false)
    if (!result) return

    if (!result.ok) {
      reportNotice(LOOKUP_FAILURES[result.reason])
      return
    }
    await load()
    setLookupText('')
    setSelectedId(result.item.id)
    reportNotice(`Added “${describeSource(result.item)}”.`)
  }

  const removeSource = async (): Promise<void> => {
    if (!selected) return
    if (!window.confirm(`Delete "${describeSource(selected)}"? Citations to it will read as removed.`)) return
    await remove(selected.id)
    setSelectedId(null)
  }

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>Sources</PanelHeader>
        <EmptyState title="No project open" />
      </PanelShell>
    )
  }

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1">Sources</span>
        <ToolbarButton label="New source" onClick={() => void addSource()}>
          ＋
        </ToolbarButton>
        <ToolbarButton label="Import sources" onClick={() => void importSources()} disabled={busy}>
          Import…
        </ToolbarButton>
        <ToolbarButton label="Delete source" onClick={() => void removeSource()} disabled={!selected}>
          ✕
        </ToolbarButton>
      </PanelHeader>

      {/*
        One field for both identifiers rather than a DOI box and an ISBN box:
        which one a string is can be told from the string, and asking someone
        to classify what they just copied is asking them to do the computer's
        job.
      */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <TextInput
          value={lookupText}
          placeholder="Add by DOI or ISBN"
          aria-label="Add by DOI or ISBN"
          data-testid="source-lookup"
          onChange={(event) => setLookupText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void lookUp()
          }}
        />
        <ToolbarButton label="Look up" onClick={() => void lookUp()} disabled={!lookupText.trim() || busy}>
          Add
        </ToolbarButton>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ul className="w-40 shrink-0 overflow-auto border-r border-border py-1" data-testid="source-list">
          {sorted.map((source) => (
            <li key={source.id}>
              <button
                type="button"
                onClick={() => setSelectedId(source.id)}
                className={cx(
                  'block w-full truncate px-2 py-1 text-left text-[12px]',
                  selected?.id === source.id ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2'
                )}
              >
                {isProvisional(source) ? '⚠ ' : ''}
                {describeSource(source) || '(untitled)'}
              </button>
            </li>
          ))}
        </ul>

        {selected ? (
          <SourceDetail
            source={selected}
            onPatch={(changes) => patch(selected.id, changes)}
            onAccept={() => void accept(selected.id)}
          />
        ) : (
          <EmptyState title="No sources yet" hint="Add one, then cite it by typing [ in a document." />
        )}
      </div>
    </PanelShell>
  )
}

function SourceDetail({
  source,
  onPatch,
  onAccept
}: {
  source: CslItem
  onPatch: (changes: Partial<CslItem>) => void
  onAccept: () => void
}) {
  const authors = source.author ?? []
  const year = source.issued?.['date-parts']?.[0]?.[0]

  const patchAuthor = (index: number, changes: Partial<CslName>): void => {
    onPatch({ author: authors.map((author, position) => (position === index ? { ...author, ...changes } : author)) })
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-3" data-testid="source-detail">
      {/*
        Said in the plainest words available, and not softened.
        The assistant does not browse, so this citation is its own attribution
        — and a confident fabricated reference in a thesis bibliography is
        career damage, which is a different order of failure from a wrong
        detail on a character card.
      */}
      {isProvisional(source) ? (
        <div className="mb-3 rounded border border-danger p-2" data-testid="source-provisional">
          <p className="text-[11px] text-danger">
            Attributed by the assistant — not verified. It cannot browse, so this reference may not
            exist. Check it against the work itself before citing it.
          </p>
          <div className="mt-2">
            <ToolbarButton
              label="Mark this source as checked"
              data-testid="source-accept"
              onClick={onAccept}
            >
              I have checked this
            </ToolbarButton>
          </div>
        </div>
      ) : null}

      <Field label="Type">
        <Select value={source.type} onChange={(event) => onPatch({ type: event.target.value })}>
          {CSL_TYPES.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
          {!CSL_TYPES.some((type) => type.id === source.type) ? (
            <option value={source.type}>{source.type}</option>
          ) : null}
        </Select>
      </Field>

      <Field label="Title">
        <TextInput
          value={source.title ?? ''}
          onChange={(event) => onPatch({ title: event.target.value })}
          data-testid="source-title"
        />
      </Field>

      <Field label="Year">
        <TextInput
          type="number"
          value={year ?? ''}
          onChange={(event) => {
            const value = event.target.value
            onPatch({ issued: value ? { 'date-parts': [[Number(value)]] } : undefined })
          }}
        />
      </Field>

      <Field label="Publication / container">
        <TextInput
          value={source['container-title'] ?? ''}
          onChange={(event) => onPatch({ 'container-title': event.target.value })}
        />
      </Field>

      <Field label="Publisher">
        <TextInput value={source.publisher ?? ''} onChange={(event) => onPatch({ publisher: event.target.value })} />
      </Field>

      <Field label="DOI">
        <TextInput value={source.DOI ?? ''} onChange={(event) => onPatch({ DOI: event.target.value })} />
      </Field>

      <Field label="URL">
        <TextInput value={source.URL ?? ''} onChange={(event) => onPatch({ URL: event.target.value })} />
      </Field>

      <p className="mb-1 mt-3 text-[11px] font-medium uppercase tracking-wide text-muted">Authors</p>
      {authors.map((author, index) => (
        <div key={index} className="mb-2 flex items-center gap-2">
          <TextInput
            placeholder="Given"
            value={author.given ?? ''}
            onChange={(event) => patchAuthor(index, { given: event.target.value })}
          />
          <TextInput
            placeholder="Family"
            value={author.family ?? ''}
            onChange={(event) => patchAuthor(index, { family: event.target.value })}
          />
          <ToolbarButton
            label="Remove author"
            onClick={() => onPatch({ author: authors.filter((_author, position) => position !== index) })}
          >
            ✕
          </ToolbarButton>
        </div>
      ))}
      <ToolbarButton label="Add author" className="w-full justify-start" onClick={() => onPatch({ author: [...authors, {}] })}>
        ＋ author
      </ToolbarButton>

      <AttachmentsSection source={source} />
    </div>
  )
}

/**
 * Attachments (PDFs and web captures) for a source, stored under
 * `.thepub/research/<sourceId>/` — see `sourceService.ts` and
 * `docs/phase-11-plan.md`'s "Attachments live beside the source". Kept in the
 * source's own detail view rather than a separate panel: attaching a
 * reference is part of describing the source, the same activity as filling
 * in its title or DOI.
 */
function AttachmentsSection({ source }: { source: CslItem }) {
  const attachments = useResearchStore((store) => store.attachmentsBySource[source.id]) ?? EMPTY_ATTACHMENTS
  const loadAttachments = useResearchStore((store) => store.loadAttachments)
  const addPdf = useResearchStore((store) => store.addPdf)
  const capturePage = useResearchStore((store) => store.capturePage)
  const addCapture = useResearchStore((store) => store.addCapture)
  const removeAttachment = useResearchStore((store) => store.removeAttachment)
  const readCapture = useResearchStore((store) => store.readCapture)

  const fileInput = useRef<HTMLInputElement>(null)
  const [captureUrl, setCaptureUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<{ attachmentId: string; capture: Capture } | null>(null)

  useEffect(() => {
    void loadAttachments(source.id)
  }, [source.id, loadAttachments])

  const pickPdf = async (file: File): Promise<void> => {
    setBusy(true)
    const bytes = await file.arrayBuffer()
    await addPdf(source.id, bytes, file.name)
    setBusy(false)
  }

  const captureAndAdd = async (): Promise<void> => {
    const url = captureUrl.trim()
    if (!url || busy) return
    setBusy(true)
    const result = await capturePage(url)
    if (!result) {
      setBusy(false)
      return
    }
    if (!result.ok) {
      setBusy(false)
      reportNotice(CAPTURE_FAILURES[result.reason])
      return
    }
    await addCapture(source.id, result.capture, url)
    // addCaptureAttachment also merges the capture's URL/accessed into the
    // source's own CSL fields on disk — reload so this store's copy agrees.
    await useSourceStore.getState().load()
    setBusy(false)
    setCaptureUrl('')
  }

  const openCapture = async (attachment: ResearchAttachment): Promise<void> => {
    const capture = await readCapture(source.id, attachment.id)
    if (capture) setViewing({ attachmentId: attachment.id, capture })
  }

  if (viewing) {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <div className="mb-2 flex items-center gap-1">
          <ToolbarButton label="Back to attachments" onClick={() => setViewing(null)}>
            ← Back
          </ToolbarButton>
          <p className="flex-1 truncate text-[12px] font-medium text-text">{viewing.capture.title}</p>
        </div>
        <p className="mb-2 truncate text-[11px] text-faint" title={viewing.capture.url}>
          {viewing.capture.url} · captured {viewing.capture.accessed}
        </p>
        <div
          data-testid="capture-text"
          className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-surface-2 p-2 text-[12px] text-text"
        >
          {viewing.capture.text}
        </div>
      </div>
    )
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Attachments</p>

      {attachments.length === 0 ? (
        <p className="mb-2 text-[11px] text-faint">No PDFs or web captures attached yet.</p>
      ) : (
        <ul className="mb-2">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="flex items-center gap-1 border-b border-border/60 py-1">
              <span className="text-[12px]">{attachment.kind === 'pdf' ? '📄' : '🔗'}</span>
              <button
                type="button"
                onClick={() => (attachment.kind === 'capture' ? void openCapture(attachment) : undefined)}
                disabled={attachment.kind !== 'capture'}
                className="flex-1 truncate text-left text-[12px] text-muted hover:text-text disabled:hover:text-muted"
                title={attachment.label || attachment.title}
              >
                {attachment.label || attachment.title || '(untitled)'}
              </button>
              <ToolbarButton
                label="Remove attachment"
                onClick={() => void removeAttachment(source.id, attachment.id)}
              >
                ✕
              </ToolbarButton>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void pickPdf(file)
        }}
      />
      <ToolbarButton
        label="Add PDF attachment"
        className="w-full justify-start"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
      >
        ＋ PDF…
      </ToolbarButton>

      <div className="mt-1 flex items-center gap-1">
        <TextInput
          value={captureUrl}
          placeholder="Capture a web page by URL"
          aria-label="Capture a web page by URL"
          data-testid="capture-url"
          onChange={(event) => setCaptureUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void captureAndAdd()
          }}
        />
        <ToolbarButton label="Capture" onClick={() => void captureAndAdd()} disabled={!captureUrl.trim() || busy}>
          Capture
        </ToolbarButton>
      </div>
    </div>
  )
}

const EMPTY_ATTACHMENTS: ResearchAttachment[] = []

/** Written to be shown verbatim, mirroring `LOOKUP_FAILURES` above. */
const CAPTURE_FAILURES: Record<string, string> = {
  offline: 'Could not reach that page. Check your connection and try again.',
  'not-found': 'That page could not be found (404).',
  unreadable: 'That page had no readable text to capture.'
}
