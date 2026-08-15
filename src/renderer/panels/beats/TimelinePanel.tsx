import { useEffect, useMemo, useState } from 'react'
import { beatsInChronology } from '@shared/model/beat.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useBeatStore } from '@renderer/stores/beatStore.js'
import { useEntityStore } from '@renderer/stores/entityStore.js'
import { useAppStore } from '@renderer/stores/appStore.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton, cx } from '@renderer/ui/primitives.js'
import { promptForName } from '@renderer/ui/PromptDialog.js'
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

  const orientation = useAppStore((store) => store.state?.timelineOrientation ?? 'horizontal')
  const setOrientation = useAppStore((store) => store.setTimelineOrientation)
  const horizontal = orientation === 'horizontal'

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const ordered = useMemo(() => beatsInChronology(beats), [beats])
  const selected = ordered.find((beat) => beat.id === selectedId) ?? null

  useEffect(() => {
    if (!project) return
    void useBeatStore.getState().load()
  }, [project?.root])

  const addBeat = async (owner?: Document): Promise<void> => {
    const title = await promptForName({ title: 'New beat', ownerDocument: owner })
    if (!title) return
    const beat = await create(title)
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
        <ToolbarButton
          label="Lay the timeline out left to right"
          active={horizontal}
          onClick={() => void setOrientation('horizontal')}
          data-testid="timeline-horizontal"
        >
          ↔
        </ToolbarButton>
        <ToolbarButton
          label="Lay the timeline out top to bottom"
          active={!horizontal}
          onClick={() => void setOrientation('vertical')}
          data-testid="timeline-vertical"
        >
          ↕
        </ToolbarButton>
        <ToolbarButton
          label="New beat"
          onClick={(event) => void addBeat(event.currentTarget.ownerDocument)}
        >
          ＋
        </ToolbarButton>
      </PanelHeader>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cx('min-w-0 flex-1 p-3', horizontal ? 'overflow-x-auto' : 'overflow-y-auto')}
          data-testid="timeline-list"
          data-orientation={orientation}
        >
          {ordered.length === 0 ? (
            <EmptyState
              title="No beats yet"
              hint="Add the moments of your story; date them, or drag them into order."
            />
          ) : (
            <ol
              className={cx(
                'relative',
                horizontal
                  ? 'flex h-full items-start gap-3 border-t border-border pt-4 mt-2'
                  : 'ml-2 border-l border-border pl-4'
              )}
            >
              {ordered.map((beat, index) => (
                <li
                  key={beat.id}
                  className={cx('relative', horizontal ? 'w-56 shrink-0' : 'pb-2')}
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
                      'absolute h-2 w-2 rounded-full',
                      horizontal ? '-top-[21px] left-2' : '-left-[21px] top-2',
                      beat.when.sort === null ? 'bg-faint' : 'bg-accent'
                    )}
                  />
                  {dropIndex === index ? (
                    <span
                      className={cx(
                        'absolute bg-accent',
                        horizontal ? '-left-1.5 -top-4 bottom-0 w-px' : '-left-4 -top-0.5 right-0 h-px'
                      )}
                    />
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
                className={cx(horizontal ? 'h-full w-12 shrink-0' : 'h-6')}
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
