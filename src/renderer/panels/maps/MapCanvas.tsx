import { useEffect, useRef, useState } from 'react'
import type { StoryMap, MapShape, Point, Bounds } from '@shared/model/map.js'
import {
  pathData,
  simplifyPath,
  toMapSpace,
  zoomView,
  viewBoxOf,
  DEFAULT_VIEW,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_AREA_OPACITY
} from '@shared/model/map.js'
import { cx } from '@renderer/ui/primitives.js'
import { useAssetUrl } from '@renderer/lib/assets.js'
import { MapIconGlyph } from './MapIconGlyph.js'

export type MapTool = 'select' | 'marker' | 'path' | 'area' | 'label'

/**
 * The drawing surface: one SVG, panned and zoomed by its `viewBox`.
 *
 * Nothing here transforms the shapes themselves. Pan and zoom move the window
 * onto the map, so a marker's coordinates are the same number whatever the
 * author is looking at — which is what lets a click be turned back into map
 * space with one inverse transform instead of a matrix stack.
 */
export function MapCanvas({
  map,
  tool,
  selectedId,
  color,
  strokeWidth,
  onSelect,
  onDraw,
  onMove,
  onOpenShape
}: {
  map: StoryMap
  tool: MapTool
  selectedId: string | null
  color: string
  strokeWidth: number
  onSelect: (shapeId: string | null) => void
  onMove: (shapeId: string, point: Point) => void
  onDraw: (kind: Exclude<MapTool, 'select'>, points: Point[]) => void
  onOpenShape: (shape: MapShape) => void
}) {
  const host = useRef<SVGSVGElement>(null)
  const [view, setView] = useState<Bounds>(() => fullView(map))
  const [stroke, setStroke] = useState<Point[]>([])
  const [panFrom, setPanFrom] = useState<Point | null>(null)
  const [dragging, setDragging] = useState<{ id: string; point: Point } | null>(null)
  const backgroundUrl = useAssetUrl(map.background)

  // Each map gets its own opening view. Before backgrounds every map shared
  // one 1000×1000 box, so carrying the pan across a switch merely disoriented;
  // with per-image dimensions it would open a portrait map on empty space.
  useEffect(() => {
    setView(fullView(map))
  }, [map.id])

  const at = (event: { clientX: number; clientY: number }): Point => {
    const rect = host.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return toMapSpace({ x: event.clientX, y: event.clientY }, rect, view)
  }

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    // Middle button or the select tool pans; a drawing tool draws.
    if (tool === 'select' || event.button === 1) {
      setPanFrom(at(event))
      if (event.target === host.current) onSelect(null)
      return
    }
    const point = at(event)
    if (tool === 'marker' || tool === 'label') {
      onDraw(tool, [point])
      return
    }
    host.current?.setPointerCapture(event.pointerId)
    setStroke([point])
  }

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (dragging) {
      setDragging({ id: dragging.id, point: at(event) })
      return
    }
    if (panFrom) {
      const now = at(event)
      setView((current) => ({
        ...current,
        x: current.x - (now.x - panFrom.x),
        y: current.y - (now.y - panFrom.y)
      }))
      return
    }
    if (stroke.length === 0) return
    setStroke((points) => [...points, at(event)])
  }

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (dragging) {
      host.current?.releasePointerCapture(event.pointerId)
      // Written once, on release, like a freehand stroke — not on every sample,
      // which would push pointer-rate writes through the save debounce.
      onMove(dragging.id, dragging.point)
      setDragging(null)
      return
    }
    setPanFrom(null)
    if (stroke.length === 0) return
    host.current?.releasePointerCapture(event.pointerId)
    // Simplify once, on release: a stroke is stored as the points that carry
    // its shape, not as every sample the pointer emitted.
    const points = simplifyPath(stroke, view.width / 400)
    setStroke([])
    if (points.length >= 2 && (tool === 'path' || tool === 'area')) onDraw(tool, points)
  }

  const onWheel = (event: React.WheelEvent<SVGSVGElement>): void => {
    setView((current) => zoomView(current, event.deltaY > 0 ? 1.15 : 1 / 1.15, at(event)))
  }

  return (
    <svg
      ref={host}
      data-testid="map-canvas"
      viewBox={viewBoxOf(view)}
      className={cx(
        'h-full w-full touch-none bg-surface-2',
        tool === 'select' ? 'cursor-grab' : 'cursor-crosshair'
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onWheel={onWheel}
    >
      <rect x={0} y={0} width={map.width} height={map.height} className="fill-surface stroke-border" />

      {backgroundUrl ? (
        // Letterboxed rather than stretched: the map's box either came from
        // this image or was deliberately kept when it was replaced, and
        // stretching a replacement would move nothing but distort everything.
        <image
          data-testid="map-background"
          href={backgroundUrl}
          x={0}
          y={0}
          width={map.width}
          height={map.height}
          preserveAspectRatio="xMidYMid meet"
        />
      ) : null}

      {map.shapes
        .map((shape) =>
          shape.id === dragging?.id ? { ...shape, points: [dragging.point] } : shape
        )
        .map((shape) => (
        <ShapeView
          key={shape.id}
          shape={shape}
          selected={shape.id === selectedId}
          scale={view.width / map.width}
          onSelect={() => onSelect(shape.id)}
          onDragStart={(event) => {
            host.current?.setPointerCapture(event.pointerId)
            setDragging({ id: shape.id, point: at(event) })
          }}
          onOpen={() => onOpenShape(shape)}
        />
      ))}

      {stroke.length > 1 ? (
        <path
          d={pathData(stroke, tool === 'area')}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth * (view.width / map.width)}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  )
}

function ShapeView({
  shape,
  selected,
  scale,
  onSelect,
  onDragStart,
  onOpen
}: {
  shape: MapShape
  selected: boolean
  scale: number
  onSelect: () => void
  onDragStart: (event: React.PointerEvent) => void
  onOpen: () => void
}) {
  const color = shape.color ?? '#7aa2f7'
  // Markers and text keep a constant on-screen size as the map is zoomed;
  // otherwise a label is unreadable at one zoom and covers a county at another.
  const unit = 8 * scale
  // The author's chosen weight, still compensated for zoom so a stroke looks
  // the same thickness however far in the map is.
  const width = (shape.strokeWidth ?? DEFAULT_STROKE_WIDTH) * scale
  const point = shape.points[0] ?? { x: 0, y: 0 }

  const common = {
    'data-testid': 'map-shape',
    'data-shape-id': shape.id,
    onPointerDown: (event: React.PointerEvent) => {
      // Stops the canvas beneath from reading this as a press on empty space
      // and clearing the selection — which is also why a drag has to begin
      // here rather than in the canvas's own handler.
      event.stopPropagation()
      onSelect()
      if (isDraggable(shape, selected)) onDragStart(event)
    },
    onDoubleClick: (event: React.MouseEvent) => {
      event.stopPropagation()
      onOpen()
    },
    className: 'cursor-pointer'
  }

  if (shape.kind === 'marker') {
    // An icon needs a disc behind it to stay legible over a busy background;
    // a plain marker is the disc. Everything downstream is sized off `radius`
    // so the label and the drill-down ring follow whichever it is.
    const radius = shape.icon ? unit * 1.35 : unit
    return (
      <g {...common}>
        {shape.icon ? (
          <>
            <circle
              cx={point.x}
              cy={point.y}
              r={radius}
              className="fill-surface"
              stroke={selected ? '#ffffff' : color}
              strokeWidth={width}
            />
            <g transform={`translate(${point.x - radius * 0.8} ${point.y - radius * 0.8})`}>
              <MapIconGlyph icon={shape.icon} size={radius * 1.6} color={color} />
            </g>
          </>
        ) : (
          <circle
            cx={point.x}
            cy={point.y}
            r={radius}
            fill={color}
            stroke={selected ? '#ffffff' : color}
            strokeWidth={width}
          />
        )}
        {shape.text ? (
          <text x={point.x + radius * 1.5} y={point.y + unit * 0.5} fontSize={unit * 1.6} fill="currentColor">
            {shape.text}
          </text>
        ) : null}
        {shape.childMapId ? (
          <circle cx={point.x} cy={point.y} r={radius * 1.8} fill="none" stroke={color} strokeWidth={width} />
        ) : null}
      </g>
    )
  }

  if (shape.kind === 'label') {
    return (
      <text
        {...common}
        x={point.x}
        y={point.y}
        fontSize={unit * 2}
        fill="currentColor"
        stroke={selected ? color : undefined}
        strokeWidth={selected ? width / 2 : undefined}
      >
        {shape.text || 'Label'}
      </text>
    )
  }

  return (
    <path
      {...common}
      d={pathData(shape.points, shape.kind === 'area')}
      fill={shape.kind === 'area' ? color : 'none'}
      fillOpacity={shape.kind === 'area' ? (shape.opacity ?? DEFAULT_AREA_OPACITY) : undefined}
      stroke={color}
      strokeWidth={selected ? width * 2 : width}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  )
}

/**
 * Whether a press on this shape should start a drag.
 *
 * Only single-point shapes, and only the one already selected — a path or an
 * area would need per-vertex handles to move meaningfully, which is a different
 * feature, and requiring the selection first stops a press on the way to panning
 * from nudging something.
 */
function isDraggable(shape: MapShape, selected: boolean): boolean {
  return selected && (shape.kind === 'marker' || shape.kind === 'label')
}

/** The whole map in frame — its own box, not the one-size default. */
function fullView(map: StoryMap): Bounds {
  if (!map.width || !map.height) return DEFAULT_VIEW
  return { x: 0, y: 0, width: map.width, height: map.height }
}
