import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launch, openProject, cleanup, readJson, waitFor, type Harness } from './helpers.js'
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
