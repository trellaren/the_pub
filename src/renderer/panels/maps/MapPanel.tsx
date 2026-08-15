import { useEffect, useMemo, useRef, useState } from 'react'
import type { MapShape, MapIcon } from '@shared/model/map.js'
import {
  breadcrumbTo,
  wouldCycle,
  clampStrokeWidth,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_AREA_OPACITY,
  MIN_STROKE_WIDTH,
  MAX_STROKE_WIDTH
} from '@shared/model/map.js'
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
  NumberField,
  SectionTitle,
  Divider,
  cx
} from '@renderer/ui/primitives.js'
import { promptForName } from '@renderer/ui/PromptDialog.js'
import { invoke, attempt, errorMessage, reportError } from '@renderer/lib/ipc.js'
import { bytesToBase64 } from '@renderer/lib/assets.js'
import { fitToMapBox } from '@shared/model/map.js'
import { MapCanvas, type MapTool } from './MapCanvas.js'
import { MAP_ICON_KEYS, MAP_ICON_LABELS } from './icons.js'
import { MapIconGlyph } from './MapIconGlyph.js'
import { NewMapDialog } from './NewMapDialog.js'

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
  const [icon, setIcon] = useState<MapIcon | null>(null)
  const [strokeWidth, setStrokeWidth] = useState(DEFAULT_STROKE_WIDTH)
  const [opacity, setOpacity] = useState(DEFAULT_AREA_OPACITY)
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  const [newMap, setNewMap] = useState<{ owner?: Document } | null>(null)
  /** Where this pane actually lives — the popout's document when torn off. */
  const paneRef = useRef<HTMLDivElement>(null)
  const backgroundInput = useRef<HTMLInputElement>(null)

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

  /**
   * Bring an image into the project and hang it behind an existing map.
   *
   * A map that already has shapes keeps its box and letterboxes the new image
   * — adopting the image's dimensions would silently move every placed marker.
   * An empty map adopts them, because there is nothing to displace.
   */
  const importBackground = async (file: File): Promise<void> => {
    if (!map) return
    try {
      const buffer = await file.arrayBuffer()
      const bitmap = await createImageBitmap(file)
      const size = fitToMapBox(bitmap.width, bitmap.height)
      bitmap.close()
      const asset = await attempt(
        invoke('doc:writeAsset', {
          dataBase64: bytesToBase64(new Uint8Array(buffer)),
          ext: file.name.split('.').pop() ?? 'png'
        }),
        'Could not import the image'
      )
      if (!asset) return
      useMapStore.getState().setBackground(map.id, asset.path, map.shapes.length === 0 ? size : undefined)
    } catch (error) {
      reportError(`Could not read that image: ${errorMessage(error)}`)
    }
  }

  const deleteMap = async (): Promise<void> => {
    if (!map) return
    if (!window.confirm(`Delete "${map.name}"? Markers that opened it become plain markers.`)) return
    await useMapStore.getState().remove(map.id)
    setSelectedShapeId(null)
  }

  const draw = async (kind: Exclude<MapTool, 'select'>, points: { x: number; y: number }[]): Promise<void> => {
    if (!map) return
    let text = ''
    if (kind === 'label') {
      // The trigger is a pointer-up on the canvas, not a click on a button, so
      // the pane's own element supplies the document the dialog belongs in.
      const asked = await promptForName({
        title: 'Label',
        confirmLabel: 'Place',
        ownerDocument: paneRef.current?.ownerDocument
      })
      if (!asked) return
      text = asked
    }
    const created = useMapStore.getState().addShape(map.id, kind, points, text)
    if (created) {
      // How it was drawn, recorded on the shape — so the inspector can change
      // any of it afterwards, the way colour already worked.
      useMapStore.getState().patchShape(map.id, created.id, {
        color,
        strokeWidth,
        opacity,
        ...(kind === 'marker' ? { icon } : {})
      })
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
    <PanelShell ref={paneRef}>
      <PanelHeader>
        <span className="flex-1">Maps</span>
        <ToolbarButton
          label="New map"
          onClick={(event) => setNewMap({ owner: event.currentTarget.ownerDocument })}
        >
          ＋
        </ToolbarButton>
        <ToolbarButton label="Delete map" onClick={() => void deleteMap()} disabled={!map}>
          ✕
        </ToolbarButton>
      </PanelHeader>

      {maps.length === 0 ? (
        <EmptyState
          title="No maps yet"
          hint="Import an image to draw over, or sketch the world from scratch."
          action={
            <button
              type="button"
              data-testid="maps-empty-create"
              className="pub-focus-ring h-7 rounded bg-accent-soft px-3 text-[12px] text-accent hover:brightness-110"
              onClick={(event) => setNewMap({ owner: event.currentTarget.ownerDocument })}
            >
              New map…
            </button>
          }
        />
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
            {tool === 'marker' ? (
              <Select
                value={icon ?? ''}
                onChange={(event) => setIcon((event.target.value || null) as MapIcon | null)}
                title="Icon for new markers"
                data-testid="map-tool-icon"
                className="ml-1 h-6"
              >
                <option value="">Plain marker</option>
                {MAP_ICON_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {MAP_ICON_LABELS[key]}
                  </option>
                ))}
              </Select>
            ) : null}
            {tool === 'path' || tool === 'area' ? (
              <input
                type="number"
                min={MIN_STROKE_WIDTH}
                max={MAX_STROKE_WIDTH}
                step={0.5}
                value={strokeWidth}
                onChange={(event) => setStrokeWidth(clampStrokeWidth(Number(event.target.value)))}
                title="Stroke width for new shapes"
                data-testid="map-tool-stroke-width"
                className="pub-focus-ring ml-1 h-6 w-14 rounded border border-border bg-surface-2 px-1 text-[12px] text-text"
              />
            ) : null}
            {tool === 'area' ? (
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(event) => setOpacity(Number(event.target.value))}
                title="Fill opacity for new regions"
                data-testid="map-tool-opacity"
                className="ml-1 h-6 w-16 cursor-pointer"
              />
            ) : null}
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
                  strokeWidth={strokeWidth}
                  selectedId={selectedShapeId}
                  onSelect={setSelectedShapeId}
                  onDraw={(kind, points) => void draw(kind, points)}
                  onMove={(shapeId, point) =>
                    useMapStore.getState().patchShape(map.id, shapeId, { points: [point] })
                  }
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

                {shape.kind === 'marker' ? (
                  <Field label="Icon">
                    <div className="grid grid-cols-5 gap-1" data-testid="shape-icon-grid">
                      <button
                        type="button"
                        title="Plain marker"
                        aria-pressed={!shape.icon}
                        data-testid="shape-icon-none"
                        onClick={() =>
                          useMapStore.getState().patchShape(map.id, shape.id, { icon: null })
                        }
                        className={cx(
                          'pub-focus-ring flex h-7 w-7 items-center justify-center rounded border',
                          !shape.icon
                            ? 'border-accent bg-accent-soft text-accent'
                            : 'border-border text-muted hover:bg-surface-3 hover:text-text'
                        )}
                      >
                        ●
                      </button>
                      {MAP_ICON_KEYS.map((key) => (
                        <button
                          key={key}
                          type="button"
                          title={MAP_ICON_LABELS[key]}
                          aria-pressed={shape.icon === key}
                          data-testid={`shape-icon-${key}`}
                          onClick={() =>
                            useMapStore.getState().patchShape(map.id, shape.id, { icon: key })
                          }
                          className={cx(
                            'pub-focus-ring flex h-7 w-7 items-center justify-center rounded border',
                            shape.icon === key
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-border text-muted hover:bg-surface-3 hover:text-text'
                          )}
                        >
                          <MapIconGlyph icon={key} size={16} />
                        </button>
                      ))}
                    </div>
                  </Field>
                ) : null}

                {shape.kind !== 'label' ? (
                  <NumberField
                    label="Stroke width"
                    value={shape.strokeWidth}
                    step={0.5}
                    onChange={(value) =>
                      useMapStore.getState().patchShape(map.id, shape.id, {
                        strokeWidth: value === undefined ? DEFAULT_STROKE_WIDTH : clampStrokeWidth(value)
                      })
                    }
                  />
                ) : null}

                {shape.kind === 'area' ? (
                  <Field label="Fill opacity">
                    <input
                      type="range"
                      min={0.05}
                      max={1}
                      step={0.05}
                      value={shape.opacity ?? DEFAULT_AREA_OPACITY}
                      onChange={(event) =>
                        useMapStore
                          .getState()
                          .patchShape(map.id, shape.id, { opacity: Number(event.target.value) })
                      }
                      data-testid="shape-opacity"
                      className="w-full cursor-pointer"
                    />
                  </Field>
                ) : null}


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

            {map && !shape ? (
              <div
                className="w-64 shrink-0 overflow-y-auto border-l border-border p-3"
                data-testid="map-properties"
              >
                <Field label="Name">
                  <TextInput
                    value={map.name}
                    onChange={(event) => useMapStore.getState().rename(map.id, event.target.value)}
                    data-testid="map-name"
                  />
                </Field>

                <SectionTitle>Background</SectionTitle>
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    data-testid="map-set-background"
                    className="pub-focus-ring h-7 self-start rounded border border-border px-3 text-[12px] text-muted hover:bg-surface-3 hover:text-text"
                    onClick={() => backgroundInput.current?.click()}
                  >
                    {map.background ? 'Replace image…' : 'Set image…'}
                  </button>
                  {map.background ? (
                    <button
                      type="button"
                      data-testid="map-remove-background"
                      className="pub-focus-ring h-7 self-start rounded border border-border px-3 text-[12px] text-muted hover:bg-surface-3 hover:text-text"
                      // Only the reference is dropped. The file stays in
                      // assets/ — another map or a document may use it, and
                      // this app does not delete an author's files uninvited.
                      onClick={() => useMapStore.getState().setBackground(map.id, null)}
                    >
                      Remove image
                    </button>
                  ) : null}
                  <input
                    ref={backgroundInput}
                    data-testid="map-background-file"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file) void importBackground(file)
                      event.target.value = ''
                    }}
                  />
                </div>

                <SectionTitle>Size</SectionTitle>
                <p className="text-[12px] text-muted">
                  {map.width} × {map.height}
                </p>
              </div>
            ) : null}
          </div>
        </>
      )}
      {newMap ? (
        <NewMapDialog ownerDocument={newMap.owner} onClose={() => setNewMap(null)} />
      ) : null}
    </PanelShell>
  )
}
