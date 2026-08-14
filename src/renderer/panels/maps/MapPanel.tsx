import { useEffect, useMemo, useState } from 'react'
import type { MapShape } from '@shared/model/map.js'
import { breadcrumbTo, wouldCycle } from '@shared/model/map.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useMapStore } from '@renderer/stores/mapStore.js'
import { useEntityStore } from '@renderer/stores/entityStore.js'
import { useLayoutStore } from '@renderer/stores/layoutStore.js'
import {
  PanelShell,
  PanelHeader,
  EmptyState,
  ToolbarButton,
  TextInput,
  TextArea,
  Select,
  Field,
  SectionTitle,
  Divider,
  cx
} from '@renderer/ui/primitives.js'
import { MapCanvas, type MapTool } from './MapCanvas.js'

const TOOLS: { id: MapTool; label: string; glyph: string }[] = [
  { id: 'select', label: 'Select and pan', glyph: '✥' },
  { id: 'marker', label: 'Place a marker', glyph: '◉' },
  { id: 'path', label: 'Draw a route or border', glyph: '〜' },
  { id: 'area', label: 'Draw a region', glyph: '⬠' },
  { id: 'label', label: 'Write a label', glyph: 'T' }
]

/**
 * Draw, review and drill down.
 *
 * The drill-down is what makes this more than a drawing: a marker can open the
 * map of the place it marks, and can name the location record that describes
 * it — so a world map, a city map and the location pane are three views of the
 * same place rather than three copies of it.
 */
export function MapPanel() {
  const project = useProjectStore((store) => store.project)
  const maps = useMapStore((store) => store.maps)
  const activeMapId = useMapStore((store) => store.activeMapId)
  const entities = useEntityStore((store) => store.entities)

  const [tool, setTool] = useState<MapTool>('select')
  const [color, setColor] = useState('#7aa2f7')
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)

  const map = maps.find((candidate) => candidate.id === activeMapId) ?? null
  const shape = map?.shapes.find((candidate) => candidate.id === selectedShapeId) ?? null
  const trail = useMemo(() => (map ? breadcrumbTo(maps, map.id) : []), [maps, map?.id])
  const locations = useMemo(
    () => entities.filter((entity) => entity.kind === 'location'),
    [entities]
  )

  useEffect(() => {
    if (!project) return
    void useMapStore.getState().load()
  }, [project?.root])

  const addMap = async (): Promise<void> => {
    const name = window.prompt('New map', 'The world')
    if (!name?.trim()) return
    await useMapStore.getState().create(name.trim())
    setSelectedShapeId(null)
  }

  const deleteMap = async (): Promise<void> => {
    if (!map) return
    if (!window.confirm(`Delete "${map.name}"? Markers that opened it become plain markers.`)) return
    await useMapStore.getState().remove(map.id)
    setSelectedShapeId(null)
  }

  const draw = (kind: Exclude<MapTool, 'select'>, points: { x: number; y: number }[]): void => {
    if (!map) return
    const text = kind === 'label' ? (window.prompt('Label') ?? '') : ''
    if (kind === 'label' && !text.trim()) return
    const created = useMapStore.getState().addShape(map.id, kind, points, text)
    if (created) {
      useMapStore.getState().patchShape(map.id, created.id, { color })
      setSelectedShapeId(created.id)
    }
    // Back to selecting after one shape: the alternative is drawing a second
    // marker every time you go to click the first.
    if (kind === 'marker' || kind === 'label') setTool('select')
  }

  /** Double-clicking a shape follows it: into its map, or to its record. */
  const openShape = (target: MapShape): void => {
    if (target.childMapId) {
      useMapStore.getState().setActive(target.childMapId)
      setSelectedShapeId(null)
      return
    }
    if (target.entityId) useLayoutStore.getState().showPanel('locations', 'Locations')
  }

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>Maps</PanelHeader>
        <EmptyState title="No project open" />
      </PanelShell>
    )
  }

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1">Maps</span>
        <ToolbarButton label="New map" onClick={() => void addMap()}>
          ＋
        </ToolbarButton>
        <ToolbarButton label="Delete map" onClick={() => void deleteMap()} disabled={!map}>
          ✕
        </ToolbarButton>
      </PanelHeader>

      {maps.length === 0 ? (
        <EmptyState title="No maps yet" hint="Draw the world, then let its places open maps of their own." />
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
            <Select
              value={activeMapId ?? ''}
              onChange={(event) => {
                useMapStore.getState().setActive(event.target.value)
                setSelectedShapeId(null)
              }}
              data-testid="map-picker"
            >
              {maps.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </Select>
            <Divider />
            {TOOLS.map((item) => (
              <ToolbarButton
                key={item.id}
                label={item.label}
                active={tool === item.id}
                onClick={() => setTool(item.id)}
                data-testid={`map-tool-${item.id}`}
              >
                {item.glyph}
              </ToolbarButton>
            ))}
            <input
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              title="Colour for new shapes"
              className="pub-focus-ring ml-1 h-6 w-8 cursor-pointer rounded border border-border bg-surface-2"
            />
          </div>

          {trail.length > 1 ? (
            <nav className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1 text-[11px] text-muted">
              {trail.map((step, index) => (
                <span key={step.id} className="flex items-center gap-1">
                  {index > 0 ? <span className="text-faint">›</span> : null}
                  <button
                    type="button"
                    onClick={() => {
                      useMapStore.getState().setActive(step.id)
                      setSelectedShapeId(null)
                    }}
                    className={cx(
                      'hover:text-text',
                      step.id === map?.id ? 'text-text' : 'text-muted'
                    )}
                  >
                    {step.name}
                  </button>
                </span>
              ))}
            </nav>
          ) : null}

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="min-w-0 flex-1">
              {map ? (
                <MapCanvas
                  map={map}
                  tool={tool}
                  color={color}
                  selectedId={selectedShapeId}
                  onSelect={setSelectedShapeId}
                  onDraw={draw}
                  onOpenShape={openShape}
                />
              ) : null}
            </div>

            {map && shape ? (
              <div
                className="w-64 shrink-0 overflow-y-auto border-l border-border p-3"
                data-testid="map-inspector"
              >
                <Field label={shape.kind === 'label' ? 'Text' : 'Name'}>
                  <TextInput
                    value={shape.text}
                    onChange={(event) =>
                      useMapStore.getState().patchShape(map.id, shape.id, { text: event.target.value })
                    }
                    data-testid="shape-text"
                  />
                </Field>

                <Field label="Colour">
                  <input
                    type="color"
                    value={shape.color ?? '#7aa2f7'}
                    onChange={(event) =>
                      useMapStore.getState().patchShape(map.id, shape.id, { color: event.target.value })
                    }
                    className="pub-focus-ring h-7 w-12 cursor-pointer rounded border border-border bg-surface-2"
                  />
                </Field>

                <SectionTitle>Links</SectionTitle>
                <Field label="Location record">
                  <Select
                    value={shape.entityId ?? ''}
                    onChange={(event) =>
                      useMapStore
                        .getState()
                        .patchShape(map.id, shape.id, { entityId: event.target.value || null })
                    }
                  >
                    <option value="">(none)</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Opens map">
                  <Select
                    value={shape.childMapId ?? ''}
                    onChange={(event) =>
                      useMapStore
                        .getState()
                        .patchShape(map.id, shape.id, { childMapId: event.target.value || null })
                    }
                    data-testid="shape-child-map"
                  >
                    <option value="">(none)</option>
                    {maps
                      // A link that closes a loop is not offered at all, rather
                      // than offered and then silently dropped on save.
                      .filter((candidate) => !wouldCycle(maps, map.id, candidate.id))
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                  </Select>
                </Field>

                <Field label="Notes">
                  <TextArea
                    rows={4}
                    value={shape.notes}
                    onChange={(event) =>
                      useMapStore.getState().patchShape(map.id, shape.id, { notes: event.target.value })
                    }
                  />
                </Field>

                <ToolbarButton
                  label="Delete shape"
                  className="text-danger"
                  onClick={() => {
                    useMapStore.getState().removeShape(map.id, shape.id)
                    setSelectedShapeId(null)
                  }}
                >
                  Delete shape
                </ToolbarButton>
              </div>
            ) : null}
          </div>
        </>
      )}
    </PanelShell>
  )
}
