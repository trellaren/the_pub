import { useEffect, useMemo, useState } from 'react'
import { beatsInChronology } from '@shared/model/beat.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useBeatStore } from '@renderer/stores/beatStore.js'
import { useEntityStore } from '@renderer/stores/entityStore.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton, cx } from '@renderer/ui/primitives.js'
import { BeatCard } from './BeatCard.js'
import { BeatInspector } from './BeatInspector.js'
import { openBeatScene } from './beatScene.js'

/**
 * The story in the order it happens.
 *
 * Dated beats are ordered by their key; undated ones sit at the end, where they
 * can be dragged into place — which is what gives them a key. Dropping a beat
 * between two dated ones dates it, so the timeline is usable long before an
 * author has decided on a calendar.
 */
export function TimelinePanel() {
  const project = useProjectStore((store) => store.project)
  const beats = useBeatStore((store) => store.beats)
  const columns = useBeatStore((store) => store.columns)
  const entities = useEntityStore((store) => store.entities)
  const patch = useBeatStore((store) => store.patch)
  const create = useBeatStore((store) => store.create)
  const remove = useBeatStore((store) => store.remove)
  const moveInChronology = useBeatStore((store) => store.moveInChronology)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const ordered = useMemo(() => beatsInChronology(beats), [beats])
  const selected = ordered.find((beat) => beat.id === selectedId) ?? null

  useEffect(() => {
    if (!project) return
    void useBeatStore.getState().load()
  }, [project?.root])

  const addBeat = async (): Promise<void> => {
    const title = window.prompt('New beat')
    if (!title?.trim()) return
    const beat = await create(title.trim())
    if (beat) setSelectedId(beat.id)
  }

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>Timeline</PanelHeader>
        <EmptyState title="No project open" />
      </PanelShell>
    )
  }

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1">Timeline</span>
        <ToolbarButton label="New beat" onClick={() => void addBeat()}>
          ＋
        </ToolbarButton>
      </PanelHeader>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-y-auto p-3" data-testid="timeline-list">
          {ordered.length === 0 ? (
            <EmptyState
              title="No beats yet"
              hint="Add the moments of your story; date them, or drag them into order."
            />
          ) : (
            <ol className="relative ml-2 border-l border-border pl-4">
              {ordered.map((beat, index) => (
                <li
                  key={beat.id}
                  className="relative pb-2"
                  onDragOver={(event) => {
                    event.preventDefault()
                    setDropIndex(index)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const id = event.dataTransfer.getData('text/pub-beat')
                    if (id) moveInChronology(id, index)
                    setDropIndex(null)
                  }}
                >
                  <span
                    className={cx(
                      'absolute -left-[21px] top-2 h-2 w-2 rounded-full',
                      beat.when.sort === null ? 'bg-faint' : 'bg-accent'
                    )}
                  />
                  {dropIndex === index ? (
                    <span className="absolute -left-4 -top-0.5 right-0 h-px bg-accent" />
                  ) : null}
                  <BeatCard
                    beat={beat}
                    entities={entities}
                    selected={selected?.id === beat.id}
                    draggable
                    onSelect={() => setSelectedId(beat.id)}
                    onOpen={() => void openBeatScene(beat)}
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/pub-beat', beat.id)
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                  />
                </li>
              ))}
              {/* A drop target past the last beat, so something can be sent to the end. */}
              <li
                className="h-6"
                onDragOver={(event) => {
                  event.preventDefault()
                  setDropIndex(ordered.length)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const id = event.dataTransfer.getData('text/pub-beat')
                  if (id) moveInChronology(id, ordered.length)
                  setDropIndex(null)
                }}
              />
            </ol>
          )}
        </div>

        {selected ? (
          <div className="w-72 shrink-0">
            <BeatInspector
              beat={selected}
              columns={columns}
              entities={entities}
              onPatch={(changes) => patch(selected.id, changes)}
              onDelete={() => {
                void remove(selected.id)
                setSelectedId(null)
              }}
            />
          </div>
        ) : null}
      </div>
    </PanelShell>
  )
}
