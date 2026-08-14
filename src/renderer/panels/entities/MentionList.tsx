import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StoryEntity } from '@shared/model/entity.js'
import type { MentionHit } from '@shared/model/mention.js'
import { invoke, on, attempt } from '@renderer/lib/ipc.js'
import { openLocation } from '@renderer/lib/openLocation.js'
import { confirmMentionHere } from '@renderer/panels/editor/mentionActions.js'
import { Snippet } from '@renderer/ui/Snippet.js'
import { SectionTitle, ToolbarButton, cx } from '@renderer/ui/primitives.js'
import { useEntityStore } from '@renderer/stores/entityStore.js'

const NO_HITS: MentionHit[] = []

/**
 * Every place a record appears: confirmed mentions first, then the name-scan
 * suggestions underneath, each with a way to accept or silence it.
 */
export function MentionList({ entity }: { entity: StoryEntity }) {
  const [hits, setHits] = useState<MentionHit[]>(NO_HITS)
  const [busy, setBusy] = useState(false)
  const refreshCounts = useEntityStore((store) => store.refreshCounts)

  const load = useCallback(async () => {
    const results = await invoke('mentions:forEntity', { entityId: entity.id, limit: 200 }).catch(
      () => NO_HITS
    )
    setHits(results)
  }, [entity.id])

  useEffect(() => {
    void load()
  }, [load])

  // Confirming, dismissing and renaming all re-index in main; this is how the
  // list learns about work it did not start itself.
  useEffect(() => on('mentions:changed', () => void load()), [load])

  const grouped = useMemo(() => groupByPath(hits), [hits])
  const suggestions = hits.filter((hit) => !hit.confirmed).length

  const confirm = async (hit: MentionHit): Promise<void> => {
    setBusy(true)
    await confirmMentionHere(hit, entity)
    await refreshCounts()
    await load()
    setBusy(false)
  }

  const dismiss = async (hit: MentionHit): Promise<void> => {
    setBusy(true)
    await attempt(
      invoke('mentions:dismiss', { entityId: entity.id, docId: hit.docId, surface: hit.surface }),
      'Could not dismiss the suggestion'
    )
    await load()
    setBusy(false)
  }

  const confirmAll = async (): Promise<void> => {
    if (!window.confirm(`Mark all ${suggestions} suggestions as mentions of ${entity.name}?`)) return
    setBusy(true)
    await attempt(invoke('mentions:confirmAll', { entityId: entity.id }), 'Could not confirm all')
    await refreshCounts()
    await load()
    setBusy(false)
  }

  return (
    <>
      <SectionTitle>
        Appears in
        {suggestions > 0 ? (
          <ToolbarButton
            label="Confirm every suggestion"
            className="ml-2 normal-case"
            disabled={busy}
            onClick={() => void confirmAll()}
          >
            confirm all {suggestions}
          </ToolbarButton>
        ) : null}
      </SectionTitle>

      {hits.length === 0 ? (
        <p className="text-[12px] text-faint">
          Nothing yet. Type the name in a document, or @-mention this record.
        </p>
      ) : (
        grouped.map(([path, fileHits]) => (
          <div key={path} className="mb-2 border-t border-border/60 pt-1">
            <div className="truncate py-1 text-[11px] font-medium text-muted" title={path}>
              {path}
              <span className="ml-1 text-faint">{fileHits.length}</span>
            </div>
            {fileHits.map((hit) => (
              <div
                key={`${hit.docId}-${hit.blockIndex}-${hit.ordinal}-${hit.surface}`}
                className={cx(
                  'group flex items-start gap-1 rounded px-1 py-0.5 hover:bg-surface-2',
                  !hit.confirmed && 'opacity-80'
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left text-[12px] text-muted hover:text-text"
                  onClick={() =>
                    void openLocation({
                      path: hit.path,
                      title: hit.title,
                      blockIndex: hit.blockIndex,
                      term: hit.surface
                    })
                  }
                >
                  <Snippet hit={hit} />
                </button>
                {hit.confirmed ? null : (
                  <span className="flex shrink-0 gap-0.5">
                    <ToolbarButton label="Confirm mention" disabled={busy} onClick={() => void confirm(hit)}>
                      ✓
                    </ToolbarButton>
                    <ToolbarButton label="Dismiss suggestion" disabled={busy} onClick={() => void dismiss(hit)}>
                      ✕
                    </ToolbarButton>
                  </span>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </>
  )
}

function groupByPath(hits: MentionHit[]): [string, MentionHit[]][] {
  const groups = new Map<string, MentionHit[]>()
  for (const hit of hits) {
    const existing = groups.get(hit.path)
    if (existing) existing.push(hit)
    else groups.set(hit.path, [hit])
  }
  return [...groups.entries()]
}
