import type { MapIcon, StoryMap } from '@shared/model/map.js'
import { clampStrokeWidth, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH } from '@shared/model/map.js'
import { ToolbarButton, Select, Divider } from '@renderer/ui/primitives.js'
import type { MapTool } from './MapCanvas.js'
import { MAP_ICON_KEYS, MAP_ICON_LABELS } from './icons.js'
import type { Brush } from './useBrush.js'

const TOOLS: { id: MapTool; label: string; glyph: string }[] = [
  { id: 'select', label: 'Select and pan', glyph: '✥' },
  { id: 'marker', label: 'Place a marker', glyph: '◉' },
  { id: 'path', label: 'Draw a route or border', glyph: '〜' },
  { id: 'area', label: 'Draw a region', glyph: '⬠' },
  { id: 'label', label: 'Write a label', glyph: 'T' }
]

export function MapToolbar({
  maps,
  activeMapId,
  onPickMap,
  tool,
  setTool,
  brush
}: {
  maps: StoryMap[]
  activeMapId: string | null
  onPickMap: (mapId: string) => void
  tool: MapTool
  setTool: (tool: MapTool) => void
  brush: Brush
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      <Select
        value={activeMapId ?? ''}
        onChange={(event) => onPickMap(event.target.value)}
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
        value={brush.color}
        onChange={(event) => brush.setColor(event.target.value)}
        title="Colour for new shapes"
        className="pub-focus-ring ml-1 h-6 w-8 cursor-pointer rounded border border-border bg-surface-2"
      />
      {tool === 'marker' ? (
        <Select
          value={brush.icon ?? ''}
          onChange={(event) => brush.setIcon((event.target.value || null) as MapIcon | null)}
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
          value={brush.strokeWidth}
          onChange={(event) => brush.setStrokeWidth(clampStrokeWidth(Number(event.target.value)))}
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
          value={brush.opacity}
          onChange={(event) => brush.setOpacity(Number(event.target.value))}
          title="Fill opacity for new regions"
          data-testid="map-tool-opacity"
          className="ml-1 h-6 w-16 cursor-pointer"
        />
      ) : null}
    </div>
  )
}
