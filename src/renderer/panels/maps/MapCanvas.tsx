import { useRef, useState } from 'react'
import type { StoryMap, MapShape, Point, Bounds } from '@shared/model/map.js'
import {
  pathData,
  simplifyPath,
  toMapSpace,
  zoomView,
  viewBoxOf,
  DEFAULT_VIEW
} from '@shared/model/map.js'
import { cx } from '@renderer/ui/primitives.js'

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
  onSelect,
  onDraw,
  onOpenShape
}: {
  map: StoryMap
  tool: MapTool
  selectedId: string | null
  color: string
  onSelect: (shapeId: string | null) => void
  onDraw: (kind: Exclude<MapTool, 'select'>, points: Point[]) => void
  onOpenShape: (shape: MapShape) => void
}) {
  const host = useRef<SVGSVGElement>(null)
  const [view, setView] = useState<Bounds>(DEFAULT_VIEW)
  const [stroke, setStroke] = useState<Point[]>([])
  const [panFrom, setPanFrom] = useState<Point | null>(null)

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

      {map.shapes.map((shape) => (
        <ShapeView
          key={shape.id}
          shape={shape}
          selected={shape.id === selectedId}
          scale={view.width / map.width}
          onSelect={() => onSelect(shape.id)}
          onOpen={() => onOpenShape(shape)}
        />
      ))}

      {stroke.length > 1 ? (
        <path
          d={pathData(stroke, tool === 'area')}
          fill="none"
          stroke={color}
          strokeWidth={view.width / 250}
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
  onOpen
}: {
  shape: MapShape
  selected: boolean
  scale: number
  onSelect: () => void
  onOpen: () => void
}) {
  const color = shape.color ?? '#7aa2f7'
  // Markers and text keep a constant on-screen size as the map is zoomed;
  // otherwise a label is unreadable at one zoom and covers a county at another.
  const unit = 8 * scale
  const width = 2 * scale
  const point = shape.points[0] ?? { x: 0, y: 0 }

  const common = {
    'data-testid': 'map-shape',
    'data-shape-id': shape.id,
    onPointerDown: (event: React.PointerEvent) => {
      event.stopPropagation()
      onSelect()
    },
    onDoubleClick: (event: React.MouseEvent) => {
      event.stopPropagation()
      onOpen()
    },
    className: 'cursor-pointer'
  }

  if (shape.kind === 'marker') {
    return (
      <g {...common}>
        <circle
          cx={point.x}
          cy={point.y}
          r={unit}
          fill={color}
          stroke={selected ? '#ffffff' : color}
          strokeWidth={width}
        />
        {shape.text ? (
          <text x={point.x + unit * 1.5} y={point.y + unit * 0.5} fontSize={unit * 1.6} fill="currentColor">
            {shape.text}
          </text>
        ) : null}
        {shape.childMapId ? (
          <circle cx={point.x} cy={point.y} r={unit * 1.8} fill="none" stroke={color} strokeWidth={width} />
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
      fill={shape.kind === 'area' ? `${color}33` : 'none'}
      stroke={color}
      strokeWidth={selected ? width * 2 : width}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  )
}
