import { describe, it, expect } from 'vitest'
import {
  storyMapSchema,
  mapFileSchema,
  breadcrumbTo,
  rootMaps,
  wouldCycle,
  childMapIds,
  boundsOf,
  simplifyPath,
  pathData,
  toMapSpace,
  zoomView,
  fitToMapBox,
  mapShapeSchema,
  clampStrokeWidth,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_AREA_OPACITY,
  MIN_STROKE_WIDTH,
  MAX_STROKE_WIDTH,
  MAP_SIZE,
  type StoryMap
} from './map.js'

function map(id: string, children: string[] = []): StoryMap {
  return storyMapSchema.parse({
    id,
    name: id,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    shapes: children.map((childMapId, index) => ({
      id: `${id}-s${index}`,
      kind: 'marker',
      points: [{ x: 0, y: 0 }],
      childMapId
    }))
  })
}

describe('storyMapSchema', () => {
  it('fills in a square drawing space and no shapes', () => {
    const parsed = map('world')
    expect(parsed.width).toBe(MAP_SIZE)
    expect(parsed.background).toBeNull()
    expect(map('a').shapes).not.toBe(map('b').shapes)
  })

  it('defaults a shape’s links to nothing', () => {
    const shape = storyMapSchema.parse({
      id: 'm',
      name: 'm',
      created: 'x',
      modified: 'x',
      shapes: [{ id: 's', kind: 'label', text: 'Here' }]
    }).shapes[0]!
    expect(shape.entityId).toBeNull()
    expect(shape.childMapId).toBeNull()
    expect(shape.points).toEqual([])
  })

  it('parses an empty file into no maps', () => {
    expect(mapFileSchema.parse({}).maps).toEqual([])
  })
})

describe('the map tree', () => {
  const maps = [map('world', ['kingdom']), map('kingdom', ['city']), map('city'), map('moon')]

  it('lists the maps a map drills into, without repeats', () => {
    expect(childMapIds(map('world', ['city', 'city']))).toEqual(['city'])
  })

  it('walks the trail from the root down to a map', () => {
    expect(breadcrumbTo(maps, 'city').map((item) => item.id)).toEqual(['world', 'kingdom', 'city'])
  })

  it('returns just the map when nothing links to it', () => {
    expect(breadcrumbTo(maps, 'moon').map((item) => item.id)).toEqual(['moon'])
  })

  it('terminates on a loop the author built by accident', () => {
    // Without the guard this walk never returns, and the panel never renders.
    const looped = [map('a', ['b']), map('b', ['a'])]
    const trail = breadcrumbTo(looped, 'b').map((item) => item.id)
    expect(trail).toEqual(['a', 'b'])
  })

  it('lists only maps nothing drills into as roots', () => {
    expect(rootMaps(maps).map((item) => item.id)).toEqual(['world', 'moon'])
  })

  it('refuses a link that would close a loop', () => {
    expect(wouldCycle(maps, 'city', 'world')).toBe(true)
    expect(wouldCycle(maps, 'city', 'city')).toBe(true)
    expect(wouldCycle(maps, 'city', 'moon')).toBe(false)
  })

  it('does not hang deciding a link against an existing loop', () => {
    const looped = [map('a', ['b']), map('b', ['a'])]
    expect(wouldCycle(looped, 'a', 'b')).toBe(true)
  })
})

describe('geometry', () => {
  it('measures the box around a set of points', () => {
    expect(boundsOf([{ x: 2, y: 5 }, { x: 8, y: 1 }])).toEqual({ x: 2, y: 1, width: 6, height: 4 })
    expect(boundsOf([])).toBeNull()
  })

  it('keeps the ends and drops points that carry no shape', () => {
    const straight = [
      { x: 0, y: 0 },
      { x: 5, y: 0.4 },
      { x: 10, y: 0 }
    ]
    expect(simplifyPath(straight, 2)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 }
    ])
  })

  it('keeps a corner that does carry shape', () => {
    const corner = [
      { x: 0, y: 0 },
      { x: 5, y: 20 },
      { x: 10, y: 0 }
    ]
    expect(simplifyPath(corner, 2)).toHaveLength(3)
  })

  it('leaves a two-point stroke alone', () => {
    const two = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
    expect(simplifyPath(two)).toEqual(two)
  })

  it('thins a dense freehand stroke hard', () => {
    // A pointer samples every few milliseconds; unfiltered, this is what gets
    // stored and re-parsed on every open.
    const dense = Array.from({ length: 500 }, (_unused, index) => ({ x: index, y: 0 }))
    expect(simplifyPath(dense, 1)).toHaveLength(2)
  })

  it('writes an svg path, closing an area', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
    expect(pathData(points)).toBe('M 0 0 L 10 0 L 10 10')
    expect(pathData(points, true).endsWith('Z')).toBe(true)
    expect(pathData([])).toBe('')
  })

  it('rounds coordinates rather than storing pointer noise', () => {
    expect(pathData([{ x: 1.234567, y: 2 }])).toBe('M 1.23 2')
  })
})

describe('the view', () => {
  const rect = { left: 100, top: 50, width: 200, height: 200 }
  const view = { x: 0, y: 0, width: 1000, height: 1000 }

  it('turns a click into map coordinates', () => {
    expect(toMapSpace({ x: 200, y: 150 }, rect, view)).toEqual({ x: 500, y: 500 })
  })

  it('accounts for a panned and zoomed view', () => {
    const panned = { x: 500, y: 500, width: 100, height: 100 }
    expect(toMapSpace({ x: 100, y: 50 }, rect, panned)).toEqual({ x: 500, y: 500 })
  })

  it('survives a zero-sized element', () => {
    expect(toMapSpace({ x: 0, y: 0 }, { ...rect, width: 0, height: 0 }, view)).toEqual({ x: 0, y: 0 })
  })

  /*
   * The letterbox.
   *
   * The canvas is an `<svg viewBox>` with no `preserveAspectRatio` override, so
   * the browser applies the default `xMidYMid meet`: one uniform scale — the
   * tighter of the two axes — with the slack on the other axis split evenly as
   * margin. An inverse that scales each axis independently agrees with that
   * only where the margin is zero or the point is dead centre, which is exactly
   * where every test above happens to look.
   */
  describe('a box whose aspect differs from the view', () => {
    // A 1000×500 map — the shape `fitToMapBox` gives any 2:1 imported image —
    // in a 300×300 box. Uniform scale is 0.3, so the map fills the width and
    // occupies 150 of the 300 pixels of height, centred: 75px of dead band
    // above it and 75px below.
    const wide = { left: 0, top: 0, width: 300, height: 300 }
    const halfHeight = { x: 0, y: 0, width: 1000, height: 500 }

    it('still agrees at the centre, which is why this went unnoticed', () => {
      expect(toMapSpace({ x: 150, y: 150 }, wide, halfHeight)).toEqual({ x: 500, y: 250 })
    })

    it('accounts for the margin above the map when converting an off-centre point', () => {
      const point = toMapSpace({ x: 150, y: 100 }, wide, halfHeight)
      expect(point.x).toBeCloseTo(500)
      // 100px down the box is 25px into a map that starts 75px down: 25 / 0.3.
      // Scaling the axes independently would read it as (100/300) * 500 = 166.67,
      // an 83-unit miss — a sixth of the map's height, and in the top band it
      // would be off the map altogether.
      expect(point.y).toBeCloseTo(83.333, 2)
    })

    it('letterboxes the width when the box is the taller one', () => {
      // 200×400 around the same 1000×500 map: width is now the tighter axis, so
      // the scale is 0.2 and the 150px bands sit above and below. Read
      // off-centre on both axes — a centred point agrees under either formula
      // and would prove nothing.
      const tall = { left: 20, top: 10, width: 200, height: 400 }
      expect(toMapSpace({ x: 70, y: 235 }, tall, halfHeight)).toEqual({ x: 250, y: 375 })
    })

    it('reads a point in the dead band as off the map, not as an edge', () => {
      // 30px down is inside the 75px margin: above the map's own top edge.
      expect(toMapSpace({ x: 150, y: 30 }, wide, halfHeight).y).toBeLessThan(0)
    })
  })

  it('keeps the anchor under the cursor while zooming', () => {
    const anchor = { x: 250, y: 250 }
    const zoomed = zoomView(view, 0.5, anchor)
    // The anchor sat a quarter across the old box; it must still sit a quarter
    // across the new one, or the map slides away from the pointer.
    expect((anchor.x - zoomed.x) / zoomed.width).toBeCloseTo(0.25)
    expect(zoomed.width).toBe(500)
  })

  it('will not zoom past its limits', () => {
    let tight = view
    for (let i = 0; i < 20; i++) tight = zoomView(tight, 0.5, { x: 500, y: 500 })
    expect(tight.width).toBe(MAP_SIZE / 50)

    let wide = view
    for (let i = 0; i < 20; i++) wide = zoomView(wide, 2, { x: 500, y: 500 })
    expect(wide.width).toBe(MAP_SIZE * 4)
  })
})

describe('fitToMapBox', () => {
  it('scales the longer side to MAP_SIZE and keeps the aspect', () => {
    expect(fitToMapBox(2000, 1000)).toEqual({ width: 1000, height: 500 })
    expect(fitToMapBox(600, 1200)).toEqual({ width: 500, height: 1000 })
    expect(fitToMapBox(800, 800)).toEqual({ width: 1000, height: 1000 })
  })

  it('never emits a zero side, however thin the image', () => {
    expect(fitToMapBox(10_000, 1).height).toBe(1)
    expect(fitToMapBox(1, 10_000).width).toBe(1)
  })

  it('falls back to the square default on degenerate input', () => {
    expect(fitToMapBox(0, 100)).toEqual({ width: MAP_SIZE, height: MAP_SIZE })
    expect(fitToMapBox(-5, 100)).toEqual({ width: MAP_SIZE, height: MAP_SIZE })
  })
})

describe('shapes drawn before icons and brushes existed', () => {
  /*
   * Maps are read back through this schema on every load, so a shape saved by
   * an older build has to survive the trip. Nothing here is a migration — the
   * defaults are the migration.
   */
  it('takes the plain marker and the old stroke and fill it was drawn with', () => {
    const legacy = {
      id: 'a',
      kind: 'area',
      text: 'The moors',
      points: [{ x: 0, y: 0 }],
      entityId: null,
      childMapId: null,
      notes: ''
    }
    expect(mapShapeSchema.parse(legacy)).toMatchObject({
      icon: null,
      strokeWidth: DEFAULT_STROKE_WIDTH,
      opacity: DEFAULT_AREA_OPACITY
    })
  })

  it('refuses a stroke width that would vanish', () => {
    expect(() => mapShapeSchema.parse({ id: 'a', kind: 'path', strokeWidth: 0 })).toThrow()
    expect(() => mapShapeSchema.parse({ id: 'a', kind: 'path', strokeWidth: -3 })).toThrow()
  })

  it('refuses an icon it has no drawing for', () => {
    expect(() => mapShapeSchema.parse({ id: 'a', kind: 'marker', icon: 'spaceport' })).toThrow()
  })
})

describe('clampStrokeWidth', () => {
  /*
   * The panel clamps before storing rather than letting the schema refuse at
   * save time: nothing validates an IPC request on the way out, so an
   * out-of-range width would fail inside the debounced write, get swallowed
   * into a toast, and retry forever against a store that had already moved on.
   */
  it('keeps a sane width untouched', () => {
    expect(clampStrokeWidth(4)).toBe(4)
  })

  it('pulls an unusable one back into range', () => {
    expect(clampStrokeWidth(0)).toBe(MIN_STROKE_WIDTH)
    expect(clampStrokeWidth(-8)).toBe(MIN_STROKE_WIDTH)
    expect(clampStrokeWidth(9999)).toBe(MAX_STROKE_WIDTH)
  })

  it('falls back to the default for an empty or unparseable field', () => {
    expect(clampStrokeWidth(Number.NaN)).toBe(DEFAULT_STROKE_WIDTH)
  })
})
