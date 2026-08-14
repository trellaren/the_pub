import { useEffect, useState } from 'react'
import { beatsInColumn } from '@shared/model/beat.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useBeatStore } from '@renderer/stores/beatStore.js'
import { useEntityStore } from '@renderer/stores/entityStore.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton, TextInput } from '@renderer/ui/primitives.js'
import { BeatCard } from './BeatCard.js'
import { BeatInspector } from './BeatInspector.js'
import { openBeatScene } from './beatScene.js'

/**
 * The story in the order it is told: columns of cards, dragged into shape.
 *
 * Same beats as the timeline. Drag-and-drop is the native HTML5 API rather than
 * a library — a board this size needs a drag type and a drop index, and nothing
 * a dependency would add is worth the weight.
 */
export function StoryboardPanel() {
  const project = useProjectStore((store) => store.project)
  const beats = useBeatStore((store) => store.beats)
  const columns = useBeatStore((store) => store.columns)
  const entities = useEntityStore((store) => store.entities)
  const patch = useBeatStore((store) => store.patch)
  const create = useBeatStore((store) => store.create)
  const remove = useBeatStore((store) => store.remove)
  const moveInColumn = useBeatStore((store) => store.moveInColumn)
  const saveColumns = useBeatStore((store) => store.saveColumns)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = beats.find((beat) => beat.id === selectedId) ?? null

  useEffect(() => {
    if (!project) return
    void useBeatStore.getState().load()
  }, [project?.root])

  const addColumn = (): void => {
    const name = window.prompt('New column', `Part ${columns.length + 1}`)
    if (!name?.trim()) return
    void saveColumns([
      ...columns,
      { id: `col-${Date.now().toString(36)}`, name: name.trim(), order: columns.length }
    ])
  }

  const removeColumn = (id: string): void => {
    if (columns.length <= 1) return
    if (!window.confirm('Delete this column? Its beats move to the first column.')) return
    void saveColumns(columns.filter((column) => column.id !== id))
  }

  const addBeat = async (columnId: string): Promise<void> => {
    const title = window.prompt('New beat')
    if (!title?.trim()) return
    const beat = await create(title.trim(), columnId)
    if (beat) setSelectedId(beat.id)
  }

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>Storyboard</PanelHeader>
        <EmptyState title="No project open" />
      </PanelShell>
    )
  }

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1">Storyboard</span>
        <ToolbarButton label="Add column" onClick={addColumn}>
          ＋ column
        </ToolbarButton>
      </PanelHeader>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto p-2" data-testid="storyboard">
          {columns.map((column) => {
            const cards = beatsInColumn(beats, column.id)
            return (
              <section
                key={column.id}
                data-testid="board-column"
                data-column-id={column.id}
                className="flex w-56 shrink-0 flex-col rounded border border-border bg-surface"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  const id = event.dataTransfer.getData('text/pub-beat')
                  // Dropped on the column itself rather than on a card: the end.
                  if (id) moveInColumn(id, column.id, cards.length)
                }}
              >
                <header className="flex items-center gap-1 border-b border-border px-1 py-1">
                  <TextInput
                    value={column.name}
                    className="h-6 border-transparent bg-transparent"
                    onChange={(event) =>
                      void saveColumns(
                        columns.map((candidate) =>
                          candidate.id === column.id
                            ? { ...candidate, name: event.target.value }
                            : candidate
                        )
                      )
                    }
                  />
                  <span className="shrink-0 text-[10px] text-faint">{cards.length}</span>
                  <ToolbarButton label="Add beat" onClick={() => void addBeat(column.id)}>
                    ＋
                  </ToolbarButton>
                  <ToolbarButton label="Delete column" onClick={() => removeColumn(column.id)}>
                    ✕
                  </ToolbarButton>
                </header>

                <div className="flex min-h-16 flex-1 flex-col gap-1 overflow-y-auto p-1">
                  {cards.map((beat, index) => (
                    <div
                      key={beat.id}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        const id = event.dataTransfer.getData('text/pub-beat')
                        if (id) moveInColumn(id, column.id, index)
                      }}
                    >
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
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
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
