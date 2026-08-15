import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launch, openProject, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import { writeTinyPng, tinyPngBytes, loadImage, TINY_PNG_WIDTH, TINY_PNG_HEIGHT } from './images.js'
import type { MapFile } from '../src/shared/model/map.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

function mapsFile(): string {
  return path.join(harness.projectDir, '.thepub', 'maps.json')
}

async function storedMaps(): Promise<MapFile['maps']> {
  return (await readJson<MapFile>(mapsFile())).maps
}

async function createMap(name: string) {
  return harness.page.evaluate((target) => window.__pub.maps.getState().create(target), name)
}

test('a map and its shapes reach disk', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const map = await createMap('The world')

  await harness.page.evaluate((id) => {
    const store = window.__pub.maps.getState()
    store.addShape(id, 'marker', [{ x: 100, y: 200 }], 'Ashfall')
    store.addShape(id, 'path', [{ x: 0, y: 0 }, { x: 500, y: 500 }], 'The old road')
    return store.flush()
  }, map!.id)

  await waitFor(async () => (await storedMaps())[0]?.shapes.length === 2, 'shapes to be written')
  const stored = (await storedMaps())[0]!
  expect(stored.name).toBe('The world')
  expect(stored.shapes.map((shape) => shape.kind)).toEqual(['marker', 'path'])
  expect(stored.shapes[0]!.points).toEqual([{ x: 100, y: 200 }])
})

test('maps and shapes survive reopening the project', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const map = await createMap('The world')
  await harness.page.evaluate((id) => {
    window.__pub.maps.getState().addShape(id, 'marker', [{ x: 10, y: 10 }], 'Keep')
    return window.__pub.maps.getState().flush()
  }, map!.id)
  await waitFor(async () => (await storedMaps()).length === 1, 'the map to be written')

  const { projectDir, userDataDir } = harness
  await harness.app.close()
  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)
  await harness.page.evaluate(() => window.__pub.maps.getState().load())

  const shapes = await harness.page.evaluate(
    () => window.__pub.maps.getState().maps[0]?.shapes.map((shape) => shape.text) ?? []
  )
  expect(shapes).toEqual(['Keep'])
})

test('a marker drills down into another map', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const world = await createMap('The world')
  const city = await createMap('Ashfall')

  const shape = await harness.page.evaluate(
    ({ worldId, cityId }) => {
      const store = window.__pub.maps.getState()
      const created = store.addShape(worldId, 'marker', [{ x: 300, y: 300 }], 'Ashfall')
      if (created) store.patchShape(worldId, created.id, { childMapId: cityId })
      return created
    },
    { worldId: world!.id, cityId: city!.id }
  )
  expect(shape).toBeTruthy()

  await harness.page.evaluate(() => window.__pub.maps.getState().flush())
  await waitFor(async () => {
    const stored = await storedMaps()
    return stored.find((map) => map.id === world!.id)?.shapes[0]?.childMapId === city!.id
  }, 'the drill-down link to be written')

  // The panel shows the trail from the world map down to the city.
  await harness.page.evaluate((id) => {
    window.__pub.layout.getState().showPanel('maps', 'Maps')
    window.__pub.maps.getState().setActive(id)
  }, city!.id)
  await expect(harness.page.locator('[data-testid="map-canvas"]')).toBeVisible()
  await expect(harness.page.getByRole('button', { name: 'The world' })).toBeVisible()
})

test('a link that would close a loop is refused', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const world = await createMap('The world')
  const city = await createMap('Ashfall')

  // world → city, then try city → world, which would make the trail endless.
  await harness.page.evaluate(
    ({ worldId, cityId }) => {
      const store = window.__pub.maps.getState()
      const marker = store.addShape(worldId, 'marker', [{ x: 1, y: 1 }], 'Ashfall')
      if (marker) store.patchShape(worldId, marker.id, { childMapId: cityId })
      const back = store.addShape(cityId, 'marker', [{ x: 2, y: 2 }], 'Back')
      if (back) store.patchShape(cityId, back.id, { childMapId: worldId })
      return store.flush()
    },
    { worldId: world!.id, cityId: city!.id }
  )

  await waitFor(async () => (await storedMaps()).length === 2, 'both maps to be written')
  const stored = await storedMaps()
  expect(stored.find((map) => map.id === world!.id)!.shapes[0]!.childMapId).toBe(city!.id)
  // Main drops the offending link rather than storing a cycle.
  expect(stored.find((map) => map.id === city!.id)!.shapes[0]!.childMapId).toBeNull()
})

test('deleting a map leaves the markers that opened it as plain markers', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const world = await createMap('The world')
  const city = await createMap('Ashfall')

  await harness.page.evaluate(
    ({ worldId, cityId }) => {
      const store = window.__pub.maps.getState()
      const marker = store.addShape(worldId, 'marker', [{ x: 1, y: 1 }], 'Ashfall')
      if (marker) store.patchShape(worldId, marker.id, { childMapId: cityId })
      return store.flush()
    },
    { worldId: world!.id, cityId: city!.id }
  )
  await waitFor(async () => (await storedMaps()).length === 2, 'both maps to be written')

  await harness.page.evaluate((id) => window.__pub.maps.getState().remove(id), city!.id)
  await waitFor(async () => (await storedMaps()).length === 1, 'the map to be deleted')

  const remaining = (await storedMaps())[0]!
  expect(remaining.shapes[0]!.text).toBe('Ashfall')
  expect(remaining.shapes[0]!.childMapId).toBeNull()
})

test('drawing on the canvas creates a shape', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createMap('The world')

  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('maps', 'Maps'))
  const canvas = harness.page.locator('[data-testid="map-canvas"]')
  await expect(canvas).toBeVisible()

  await harness.page.locator('[data-testid="map-tool-marker"]').click()
  const box = (await canvas.boundingBox())!
  await harness.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

  await expect(harness.page.locator('[data-testid="map-shape"]')).toHaveCount(1)
  // Placing a shape selects it, so the inspector is ready to name it.
  await expect(harness.page.locator('[data-testid="map-inspector"]')).toBeVisible()

  await harness.page.evaluate(() => window.__pub.maps.getState().flush())
  await waitFor(async () => (await storedMaps())[0]?.shapes.length === 1, 'the drawn marker to be written')
})

/*
 * Everything below drives the real UI rather than the store. The reported bug
 * was that the ＋ button did nothing at all — no test had ever clicked it.
 */

async function showMaps(): Promise<void> {
  await harness.page.evaluate(() => window.__pub.runCommand('panel.maps'))
  await expect(harness.page.getByTestId('maps-empty-create').or(harness.page.getByTestId('map-picker'))).toBeVisible()
}

test('the empty state offers a way in, and sketching creates a drawable map', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await showMaps()

  // With no maps there was previously no create affordance at all here.
  await harness.page.getByTestId('maps-empty-create').click()
  await expect(harness.page.getByTestId('new-map-dialog')).toBeVisible()
  await harness.page.getByTestId('new-map-name').fill('The world')
  await harness.page.getByTestId('new-map-create').click()

  await expect(harness.page.getByTestId('map-canvas')).toBeVisible()
  await waitFor(async () => (await storedMaps())[0]?.name === 'The world', 'the map to be written')

  const stored = (await storedMaps())[0]!
  expect(stored.background).toBeNull()
  expect(stored.width).toBe(1000)
  expect(stored.height).toBe(1000)
})

test('the label tool asks for text and places it', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createMap('The world')
  await showMaps()

  await harness.page.getByTestId('map-tool-label').click()
  const canvas = harness.page.getByTestId('map-canvas')
  const box = (await canvas.boundingBox())!
  await harness.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

  // This prompt was dead too, so the label tool could never place anything.
  await expect(harness.page.getByTestId('prompt-dialog')).toBeVisible()
  await harness.page.getByTestId('prompt-input').fill('Ashfall')
  await harness.page.getByTestId('prompt-confirm').click()

  await harness.page.evaluate(() => window.__pub.maps.getState().flush())
  await waitFor(async () => {
    const shapes = (await storedMaps())[0]?.shapes ?? []
    return shapes.some((shape) => shape.kind === 'label' && shape.text === 'Ashfall')
  }, 'the label to be written')
})

test('a map built on an imported image stores it, sizes to it, and serves it', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await showMaps()

  const imagePath = path.join(harness.projectDir, '..', `fixture-${process.pid}.png`)
  await writeTinyPng(imagePath)

  await harness.page.getByTestId('maps-empty-create').click()
  await harness.page.getByTestId('new-map-name').fill('Old charts')
  await harness.page.getByTestId('new-map-file').setInputFiles(imagePath)
  await harness.page.getByTestId('new-map-create').click()

  await waitFor(async () => (await storedMaps())[0]?.background !== null, 'the background to be recorded')
  const stored = (await storedMaps())[0]!

  // The bytes landed inside the project, under a generated name.
  expect(stored.background).toMatch(/^assets\//)
  const onDisk = await fs.readFile(path.join(harness.projectDir, stored.background!))
  expect(onDisk.equals(tinyPngBytes())).toBe(true)

  // The map took the image's 8×4 aspect, scaled into the standard box.
  expect(stored.width).toBe(1000)
  expect(stored.height).toBe(500)

  // And the renderer can actually fetch it back through pub-asset://.
  const image = harness.page.getByTestId('map-background')
  await expect(image).toBeVisible()
  const href = await image.getAttribute('href')
  expect(href).toMatch(/^pub-asset:\/\//)

  const served = await loadImage(harness.page, href!)
  expect(served).toEqual({ ok: true, width: TINY_PNG_WIDTH, height: TINY_PNG_HEIGHT })

  await fs.rm(imagePath, { force: true })
})

/*
 * The reported bug: "the cursor is inaccurate to where the objects are being
 * drawn". Every drawing test above clicks the exact centre of the canvas, which
 * is the one point where the old and the correct transforms agree — so the miss
 * was invisible to the whole suite. This clicks off-centre on a map whose aspect
 * differs from its panel, which is what an imported image always produces.
 */
test('a marker lands where the pointer was on a map that does not fill its panel', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await showMaps()

  const imagePath = path.join(harness.projectDir, '..', `fixture-offcentre-${process.pid}.png`)
  await writeTinyPng(imagePath)
  await harness.page.getByTestId('maps-empty-create').click()
  await harness.page.getByTestId('new-map-name').fill('Old charts')
  await harness.page.getByTestId('new-map-file').setInputFiles(imagePath)
  await harness.page.getByTestId('new-map-create').click()
  await waitFor(async () => (await storedMaps())[0]?.background !== null, 'the background to be recorded')

  // The 2:1 box this test depends on: the panel is never exactly 2:1, so the
  // map is letterboxed inside it and the margin is real.
  const mapBox = (await storedMaps())[0]!
  expect(mapBox.width).toBe(1000)
  expect(mapBox.height).toBe(500)

  const canvas = harness.page.getByTestId('map-canvas')
  const box = (await canvas.boundingBox())!

  // Work out where the map actually sits inside the panel, independently of the
  // code under test, then aim a quarter of the way across the map itself rather
  // than a quarter across the panel — so the target is on the map by
  // construction, and the expected answer is just the map's own quarter point.
  const scale = Math.min(box.width / mapBox.width, box.height / mapBox.height)
  const marginX = (box.width - mapBox.width * scale) / 2
  const marginY = (box.height - mapBox.height * scale) / 2
  expect(marginX > 1 || marginY > 1).toBe(true)

  await harness.page.getByTestId('map-tool-marker').click()
  await harness.page.mouse.click(
    box.x + marginX + mapBox.width * scale * 0.25,
    box.y + marginY + mapBox.height * scale * 0.25
  )

  await harness.page.evaluate(() => window.__pub.maps.getState().flush())
  await waitFor(async () => (await storedMaps())[0]?.shapes.length === 1, 'the marker to be written')

  const point = (await storedMaps())[0]!.shapes[0]!.points[0]!
  expect(point.x).toBeGreaterThan(250 - 5)
  expect(point.x).toBeLessThan(250 + 5)
  expect(point.y).toBeGreaterThan(125 - 5)
  expect(point.y).toBeLessThan(125 + 5)

  await fs.rm(imagePath, { force: true })
})

test('a marker can be given an icon, and keeps it', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createMap('The world')
  await showMaps()

  await harness.page.getByTestId('map-tool-marker').click()
  await harness.page.getByTestId('map-tool-icon').selectOption('castle')
  const box = (await harness.page.getByTestId('map-canvas').boundingBox())!
  await harness.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

  await harness.page.evaluate(() => window.__pub.maps.getState().flush())
  await waitFor(async () => (await storedMaps())[0]?.shapes[0]?.icon === 'castle', 'the icon to be written')

  // And it can be changed afterwards, from the inspector, without redrawing it.
  await harness.page.getByTestId('shape-icon-lighthouse').click()
  await harness.page.evaluate(() => window.__pub.maps.getState().flush())
  await waitFor(
    async () => (await storedMaps())[0]?.shapes[0]?.icon === 'lighthouse',
    'the icon to be changed'
  )
})

/*
 * Repositioning used to mean deleting and drawing again, which threw away the
 * record link, the drill-down and the notes — everything about the marker except
 * where it was. This drags one that carries all three.
 */
test('a selected marker can be dragged, keeping everything it was linked to', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const world = await createMap('The world')
  const city = await createMap('Ashfall')
  await harness.page.evaluate(
    ({ worldId, cityId }) => {
      const store = window.__pub.maps.getState()
      const marker = store.addShape(worldId, 'marker', [{ x: 200, y: 200 }], 'Ashfall')
      if (marker) store.patchShape(worldId, marker.id, { childMapId: cityId, notes: 'Founded in winter' })
      return store.flush()
    },
    { worldId: world!.id, cityId: city!.id }
  )
  await harness.page.evaluate((id) => window.__pub.maps.getState().setActive(id), world!.id)
  await showMaps()

  // Selected first: a press on an unselected shape still pans, so a stray drag
  // on the way somewhere else cannot nudge the map about.
  const marker = harness.page.locator('[data-testid="map-shape"]').first()
  await marker.click()
  await expect(harness.page.getByTestId('map-inspector')).toBeVisible()

  // Start from where the marker actually is on screen rather than a fraction of
  // the canvas: the map is letterboxed inside the panel, so those are not the
  // same point.
  const dot = (await marker.boundingBox())!
  const box = (await harness.page.getByTestId('map-canvas').boundingBox())!
  const from = { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 }
  const to = { x: box.x + box.width * 0.65, y: box.y + box.height * 0.6 }
  await harness.page.mouse.move(from.x, from.y)
  await harness.page.mouse.down()
  await harness.page.mouse.move(to.x, to.y, { steps: 8 })
  await harness.page.mouse.up()

  await harness.page.evaluate(() => window.__pub.maps.getState().flush())
  await waitFor(async () => {
    const point = (await storedMaps()).find((item) => item.id === world!.id)?.shapes[0]?.points[0]
    return point ? Math.abs(point.x - 200) > 50 : false
  }, 'the marker to move')

  const moved = (await storedMaps()).find((item) => item.id === world!.id)!.shapes[0]!
  expect(moved.childMapId).toBe(city!.id)
  expect(moved.notes).toBe('Founded in winter')
  expect(moved.text).toBe('Ashfall')
})

test('a background can be replaced and removed on an existing map', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createMap('The world')
  await showMaps()

  const imagePath = path.join(harness.projectDir, '..', `fixture-set-${process.pid}.png`)
  await writeTinyPng(imagePath)

  // The properties pane shows when no shape is selected.
  await expect(harness.page.getByTestId('map-properties')).toBeVisible()
  await harness.page.getByTestId('map-background-file').setInputFiles(imagePath)

  await waitFor(async () => (await storedMaps())[0]?.background !== null, 'the background to be set')
  await expect(harness.page.getByTestId('map-background')).toBeVisible()
  // An empty map adopts the image's shape, since no marker can be displaced.
  expect((await storedMaps())[0]!.height).toBe(500)

  await harness.page.getByTestId('map-remove-background').click()
  await waitFor(async () => (await storedMaps())[0]?.background === null, 'the background to be cleared')
  await expect(harness.page.getByTestId('map-background')).toHaveCount(0)

  await fs.rm(imagePath, { force: true })
})
