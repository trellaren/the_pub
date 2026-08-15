import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { MapService } from './mapService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { MAPS_FILE } from '../../shared/constants.js'

let root: string
let adapter: LocalAdapter
let maps: MapService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-maps-'))
  adapter = new LocalAdapter(root)
  maps = new MapService(adapter)
  await maps.load()
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

async function onDisk(): Promise<{ maps: { background: string | null; width: number; height: number }[] }> {
  return JSON.parse(await fs.readFile(path.join(root, MAPS_FILE), 'utf8'))
}

describe('MapService', () => {
  it('creates a sketching map with the default box and no background', async () => {
    const map = await maps.create({ name: 'The world' })
    expect(map.background).toBeNull()
    expect(map.width).toBe(1000)
    expect(map.height).toBe(1000)
  })

  it('persists an imported background and its dimensions', async () => {
    const map = await maps.create({
      name: 'Old charts',
      background: 'assets/01ABC.png',
      width: 1000,
      height: 640
    })
    expect(map.background).toBe('assets/01ABC.png')
    expect(map.height).toBe(640)

    const file = await onDisk()
    expect(file.maps[0]).toMatchObject({ background: 'assets/01ABC.png', width: 1000, height: 640 })
  })

  it('round-trips a background through save', async () => {
    const map = await maps.create({ name: 'Plain' })
    const withImage = await maps.save({ ...map, background: 'assets/later.png' })
    expect(withImage.background).toBe('assets/later.png')
    expect((await onDisk()).maps[0]!.background).toBe('assets/later.png')

    const removed = await maps.save({ ...withImage, background: null })
    expect(removed.background).toBeNull()
    expect((await onDisk()).maps[0]!.background).toBeNull()
  })
})
