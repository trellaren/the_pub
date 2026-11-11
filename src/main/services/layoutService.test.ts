import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { LayoutService } from './layoutService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { LAYOUTS_FILE, PUB_DIR } from '../../shared/constants.js'

let root: string
let adapter: LocalAdapter
let layouts: LayoutService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-layouts-'))
  await fs.mkdir(path.join(root, PUB_DIR), { recursive: true })
  adapter = new LocalAdapter(root)
  layouts = new LayoutService(adapter)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('LayoutService', () => {
  it('keeps both of two overlapping saves', async () => {
    await Promise.all([
      layouts.savePreset('Drafting', { a: 1 }),
      layouts.savePreset('Revising', { b: 2 }),
      layouts.saveLast({ c: 3 })
    ])
    const file = await layouts.load()
    expect(file.presets.map((preset) => preset.name).sort()).toEqual(['Drafting', 'Revising'])
    expect(file.lastLayout).toEqual({ c: 3 })
  })

  it('sets a corrupt file aside rather than overwriting it', async () => {
    await fs.writeFile(path.join(root, LAYOUTS_FILE), '{ "presets": [')
    await layouts.saveLast({ c: 3 })
    const names = await fs.readdir(path.join(root, PUB_DIR))
    expect(names.some((name) => name.startsWith('layouts.json.corrupt-'))).toBe(true)
  })

  it('does not overwrite presets it failed to read', async () => {
    await layouts.savePreset('Drafting', { a: 1 })
    const before = await fs.readFile(path.join(root, LAYOUTS_FILE), 'utf8')
    vi.spyOn(adapter, 'readFile').mockRejectedValueOnce(new Error('EIO'))
    await expect(layouts.saveLast({ c: 3 })).rejects.toThrow('EIO')
    expect(await fs.readFile(path.join(root, LAYOUTS_FILE), 'utf8')).toBe(before)
  })
})
