import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { readVersionedJson, SerialQueue } from './versionedJson.js'
import { ManuscriptService } from './manuscriptService.js'
import { loadOrCreateManifest } from './manifestFile.js'
import { FORMAT_VERSIONS, MANIFEST_FILE, MANUSCRIPT_FILE, NOTES_DIR } from '../../shared/constants.js'

let root: string
let adapter: LocalAdapter

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-versioned-'))
  adapter = new LocalAdapter(root)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

const schema = z.object({ formatVersion: z.number(), notes: z.array(z.string()) })
const empty = () => ({ formatVersion: FORMAT_VERSIONS.notes, notes: [] as string[] })
const file = `${NOTES_DIR}/a.json`

async function put(rel: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), text)
}

async function listing(rel: string): Promise<string[]> {
  return fs.readdir(path.join(root, rel))
}

describe('readVersionedJson', () => {
  it('propagates a read failure and leaves the file where it is', async () => {
    await put(file, JSON.stringify({ formatVersion: 1, notes: ['keep'] }))
    vi.spyOn(adapter, 'readFile').mockRejectedValueOnce(new Error('EIO'))
    await expect(readVersionedJson(adapter, file, 'notes', schema, empty)).rejects.toThrow('EIO')
    expect(await listing(NOTES_DIR)).toEqual(['a.json'])
  })

  it('quarantines content that does not parse', async () => {
    await put(file, '{ not json')
    const read = await readVersionedJson(adapter, file, 'notes', schema, empty)
    expect(read.value).toEqual(empty())
    expect(read.quarantinedTo).toMatch(/\.corrupt-\d+$/)
    expect((await listing(NOTES_DIR))[0]).toMatch(/^a\.json\.corrupt-/)
  })

  it('reads a too-new file read-only without quarantining it, even if its shape is unknown', async () => {
    await put(file, JSON.stringify({ formatVersion: FORMAT_VERSIONS.notes + 1, notes: 'reshaped' }))
    const read = await readVersionedJson(adapter, file, 'notes', schema, empty)
    expect(read.tooNew).toBe(true)
    expect(read.quarantinedTo).toBeUndefined()
    expect(await listing(NOTES_DIR)).toEqual(['a.json'])
  })
})

describe('SerialQueue', () => {
  it('keeps running tasks after one rejects', async () => {
    const queue = new SerialQueue()
    const order: number[] = []
    const failed = queue.run(async () => {
      order.push(1)
      throw new Error('disk full')
    })
    const next = queue.run(async () => {
      order.push(2)
      return 'ok'
    })
    await expect(failed).rejects.toThrow('disk full')
    await expect(next).resolves.toBe('ok')
    expect(order).toEqual([1, 2])
  })

  it('lets a manuscript save succeed after a failed one', async () => {
    const manuscript = new ManuscriptService(adapter, {
      resolvePath: () => null,
      wordCountsFor: () => new Map(),
      indexing: () => false
    })
    await manuscript.load()
    vi.spyOn(adapter, 'writeFileAtomic').mockRejectedValueOnce(new Error('offline'))
    await expect(manuscript.createPart('One')).rejects.toThrow('offline')
    await manuscript.createPart('Two')
    const saved = JSON.parse(await fs.readFile(path.join(root, MANUSCRIPT_FILE), 'utf8'))
    expect(saved.nodes.map((node: { title: string }) => node.title)).toEqual(['One', 'Two'])
  })
})

describe('loadOrCreateManifest', () => {
  it('opens a too-new manifest read-only and never replaces it', async () => {
    const text = JSON.stringify({
      formatVersion: FORMAT_VERSIONS.manifest + 1,
      id: '01ABC',
      name: 'Future',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      settings: {},
      styles: []
    })
    await put(MANIFEST_FILE, text)
    const { manifest, readOnly } = await loadOrCreateManifest(adapter)
    expect(readOnly).toBe(true)
    expect(manifest.name).toBe('Future')
    expect(await fs.readFile(path.join(root, MANIFEST_FILE), 'utf8')).toBe(text)
  })

  it('refuses a too-new manifest it cannot parse rather than replacing it', async () => {
    const text = JSON.stringify({ formatVersion: FORMAT_VERSIONS.manifest + 1, name: 42 })
    await put(MANIFEST_FILE, text)
    await expect(loadOrCreateManifest(adapter)).rejects.toThrow(/newer version/)
    expect(await fs.readFile(path.join(root, MANIFEST_FILE), 'utf8')).toBe(text)
    expect(await listing(path.dirname(MANIFEST_FILE))).toEqual([path.basename(MANIFEST_FILE)])
  })

  it('propagates a manifest read failure instead of recreating it', async () => {
    await put(MANIFEST_FILE, '{}')
    vi.spyOn(adapter, 'readFile').mockRejectedValueOnce(new Error('EIO'))
    await expect(loadOrCreateManifest(adapter)).rejects.toThrow('EIO')
    expect(await fs.readFile(path.join(root, MANIFEST_FILE), 'utf8')).toBe('{}')
  })
})
