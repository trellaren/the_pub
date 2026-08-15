import { z } from 'zod'
import { FORMAT_VERSION } from '../constants.js'

/**
 * Maps are vector drawings in their own coordinate space, stored as shapes
 * rather than pixels.
 *
 * SVG all the way down, and deliberately: shapes stay crisp at any zoom, hit
 * testing comes free from the DOM, and a map serialises to a few kilobytes of
 * JSON that diffs and syncs like everything else in `.thepub`. A raster canvas
 * would be easier to draw on and impossible to edit afterwards.
 */
export const pointSchema = z.object({ x: z.number(), y: z.number() })
export type Point = z.infer<typeof pointSchema>

export const mapShapeKinds = ['marker', 'path', 'area', 'label'] as const
export const mapShapeKindSchema = z.enum(mapShapeKinds)
export type MapShapeKind = z.infer<typeof mapShapeKindSchema>

/**
 * What a marker draws itself as.
 *
 * A closed set rather than a free string: these are drawn glyphs that have to
 * exist to be rendered, so an unknown name is a blank marker rather than a
 * useful one. Fantasy settlements and terrain first, since that is what most
 * story maps are, then the handful of neutral pins a modern or contemporary map
 * wants.
 */
export const mapIconKinds = [
  'city',
  'town',
  'village',
  'castle',
  'tower',
  'bridge',
  'forest',
  'mountain',
  'cave',
  'ruins',
  'temple',
  'farm',
  'mine',
  'port',
  'lighthouse',
  'camp',
  'crossroads',
  'flag',
  'star',
  'waypoint'
] as const
export const mapIconSchema = z.enum(mapIconKinds)
export type MapIcon = z.infer<typeof mapIconSchema>

/** How wide a stroke is drawn, before the zoom compensation in the canvas. */
export const DEFAULT_STROKE_WIDTH = 2
export const MIN_STROKE_WIDTH = 0.5
export const MAX_STROKE_WIDTH = 20
/** Matches the `33` hex alpha regions were drawn with before this was settable. */
export const DEFAULT_AREA_OPACITY = 0.2

export const mapShapeSchema = z.object({
  id: z.string(),
  kind: mapShapeKindSchema,
  /** Shown on the map for labels and markers; the shape's name elsewhere. */
  text: z.string().default(''),
  /** Map-space coordinates. A marker or label has one; a path or area has many. */
  points: z.array(pointSchema).default(() => []),
  color: z.string().optional(),
  /**
   * The glyph a marker draws, or null for the plain dot.
   *
   * Null by default so every marker drawn before icons existed keeps the
   * appearance it was given.
   */
  icon: mapIconSchema.nullable().default(null),
  strokeWidth: z.number().positive().default(DEFAULT_STROKE_WIDTH),
  /** Fill opacity, read only for regions. */
  opacity: z.number().min(0).max(1).default(DEFAULT_AREA_OPACITY),
  /** Links a place on the map to the record that describes it. */
  entityId: z.string().nullable().default(null),
  /**
   * The map this shape opens into — the drill-down. A city marker on the world
   * map points at the city's own map.
   */
  childMapId: z.string().nullable().default(null),
  notes: z.string().default('')
})
export type MapShape = z.infer<typeof mapShapeSchema>

/** Keep a typed width inside what the schema will accept. */
export function clampStrokeWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_STROKE_WIDTH
  return Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, value))
}

export const storyMapSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Project-relative path of a background image, if one was imported. */
  background: z.string().nullable().default(null),
  /** The drawing's own coordinate space; the view fits this box. */
  width: z.number().default(1000),
  height: z.number().default(1000),
  shapes: z.array(mapShapeSchema).default(() => []),
  created: z.string(),
  modified: z.string()
})
export type StoryMap = z.infer<typeof storyMapSchema>

export const mapFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  maps: z.array(storyMapSchema).default(() => [])
})
export type MapFile = z.infer<typeof mapFileSchema>

export const MAP_SIZE = 1000

/**
 * The maps a map drills into, in the order they were placed.
 *
 * Parenthood lives on the *shape*, not on the map, because a map can be reached
 * from more than one place — a tavern that appears on two city maps is one
 * tavern — and because the link and the thing you click are the same object.
 */
export function childMapIds(map: StoryMap): string[] {
  const ids: string[] = []
  for (const shape of map.shapes) {
    if (shape.childMapId && !ids.includes(shape.childMapId)) ids.push(shape.childMapId)
  }
  return ids
}

/**
 * The path from a root map down to `mapId`, or just the map itself when it is
 * not reachable from anywhere.
 *
 * The `seen` set is not defensive tidiness: a world map whose city drills into a
 * map that drills back to the world is an easy thing for an author to build by
 * accident, and without the guard the breadcrumb walk never returns.
 */
export function breadcrumbTo(maps: readonly StoryMap[], mapId: string): StoryMap[] {
  const byId = new Map(maps.map((map) => [map.id, map]))
  const target = byId.get(mapId)
  if (!target) return []

  const parentOf = new Map<string, string>()
  for (const map of maps) {
    for (const child of childMapIds(map)) {
      // First parent wins, so the trail is stable when a map is linked twice.
      if (!parentOf.has(child)) parentOf.set(child, map.id)
    }
  }

  const trail: StoryMap[] = [target]
  const seen = new Set<string>([target.id])
  let cursor = parentOf.get(target.id)
  while (cursor && !seen.has(cursor)) {
    const parent = byId.get(cursor)
    if (!parent) break
    trail.unshift(parent)
    seen.add(parent.id)
    cursor = parentOf.get(parent.id)
  }
  return trail
}

/** Maps nothing else drills into: the top of each tree, for the map list. */
export function rootMaps(maps: readonly StoryMap[]): StoryMap[] {
  const children = new Set(maps.flatMap((map) => childMapIds(map)))
  return maps.filter((map) => !children.has(map.id))
}

/** Would linking `parent` to `child` create a loop? */
export function wouldCycle(maps: readonly StoryMap[], parentId: string, childId: string): boolean {
  if (parentId === childId) return true
  const byId = new Map(maps.map((map) => [map.id, map]))
  const stack = [childId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === parentId) return true
    if (seen.has(current)) continue
    seen.add(current)
    const map = byId.get(current)
    if (map) stack.push(...childMapIds(map))
  }
  return false
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export function boundsOf(points: readonly Point[]): Bounds | null {
  if (points.length === 0) return null
  let minX = points[0]!.x
  let maxX = points[0]!.x
  let minY = points[0]!.y
  let maxY = points[0]!.y
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Thin a freehand stroke down to the points that carry its shape.
 *
 * Ramer–Douglas–Peucker. A pointer emits a sample every few milliseconds, so an
 * unfiltered coastline is thousands of points that all have to be stored,
 * re-rendered and re-parsed on every open, for a line the eye cannot tell from
 * a fiftieth of them.
 */
export function simplifyPath(points: readonly Point[], tolerance = 2): Point[] {
  if (points.length <= 2) return [...points]

  const first = points[0]!
  const last = points[points.length - 1]!
  let index = 0
  let furthest = 0
  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i]!, first, last)
    if (distance > furthest) {
      furthest = distance
      index = i
    }
  }

  if (furthest <= tolerance) return [first, last]
  const left = simplifyPath(points.slice(0, index + 1), tolerance)
  const right = simplifyPath(points.slice(index), tolerance)
  // `index` is in both halves, so drop the duplicate joint.
  return [...left.slice(0, -1), ...right]
}

function perpendicularDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y)
  const length = Math.hypot(dx, dy)
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length
}

/** An SVG path `d` for a stroke or an outline. */
export function pathData(points: readonly Point[], close = false): string {
  if (points.length === 0) return ''
  const [head, ...rest] = points
  const parts = [`M ${round(head!.x)} ${round(head!.y)}`]
  for (const point of rest) parts.push(`L ${round(point.x)} ${round(point.y)}`)
  if (close && points.length > 2) parts.push('Z')
  return parts.join(' ')
}

function round(value: number): number {
  // Two decimals is finer than any display can show at these scales, and keeps
  // the stored map small.
  return Math.round(value * 100) / 100
}

/**
 * Convert a point in the rendered element's pixels into map space.
 *
 * The view is an SVG `viewBox`, so this is the inverse of the transform the
 * browser applies: pan and zoom change the box, never the shapes.
 *
 * That transform is `xMidYMid meet` — the default, which the canvas does not
 * override. It picks a single scale, the tighter of the two axes, and centres
 * the result, leaving an equal margin at each end of the roomier axis. So the
 * inverse must divide by that one scale and subtract that margin. Scaling each
 * axis independently instead describes `preserveAspectRatio="none"`, a
 * stretch-to-fill the canvas never asks for, and lands every pointer short of
 * or beyond where it really is by the margin — invisibly at dead centre, worse
 * towards the edges, and worst on the maps most likely to be drawn on, since an
 * imported image gives the view whatever aspect the picture had.
 */
export function toMapSpace(
  client: Point,
  rect: { left: number; top: number; width: number; height: number },
  view: Bounds
): Point {
  if (rect.width === 0 || rect.height === 0 || view.width === 0 || view.height === 0) {
    return { x: view.x, y: view.y }
  }
  const scale = Math.min(rect.width / view.width, rect.height / view.height)
  const marginX = (rect.width - view.width * scale) / 2
  const marginY = (rect.height - view.height * scale) / 2
  return {
    x: view.x + (client.x - rect.left - marginX) / scale,
    y: view.y + (client.y - rect.top - marginY) / scale
  }
}

/** Zoom about a fixed point, so the map does not slide under the cursor. */
export function zoomView(view: Bounds, factor: number, anchor: Point): Bounds {
  const width = clamp(view.width * factor, MAP_SIZE / 50, MAP_SIZE * 4)
  const height = clamp(view.height * factor, MAP_SIZE / 50, MAP_SIZE * 4)
  // Keep the anchor at the same fraction across the box it was before.
  const fx = view.width === 0 ? 0.5 : (anchor.x - view.x) / view.width
  const fy = view.height === 0 ? 0.5 : (anchor.y - view.y) / view.height
  return { x: anchor.x - fx * width, y: anchor.y - fy * height, width, height }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function viewBoxOf(view: Bounds): string {
  return `${round(view.x)} ${round(view.y)} ${round(view.width)} ${round(view.height)}`
}

export const DEFAULT_VIEW: Bounds = { x: 0, y: 0, width: MAP_SIZE, height: MAP_SIZE }

/**
 * A map box for an imported image: the image's aspect, scaled so the longer
 * side is MAP_SIZE.
 *
 * Not the raw pixel size, deliberately. `zoomView`'s clamps and the default
 * view both assume coordinates on the order of MAP_SIZE — a 6000-pixel scan
 * adopted verbatim would open showing its top-left corner and refuse to zoom
 * out far enough to see itself. Normalising keeps every map, drawn or
 * imported, in the same coordinate regime.
 */
export function fitToMapBox(imageWidth: number, imageHeight: number): { width: number; height: number } {
  if (imageWidth <= 0 || imageHeight <= 0) return { width: MAP_SIZE, height: MAP_SIZE }
  const longest = Math.max(imageWidth, imageHeight)
  return {
    width: Math.max(1, Math.round((MAP_SIZE * imageWidth) / longest)),
    height: Math.max(1, Math.round((MAP_SIZE * imageHeight) / longest))
  }
}
