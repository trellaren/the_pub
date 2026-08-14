import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { BeatService, deriveMoment } from './beatService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { beatsInColumn, type BeatFile } from '../../shared/model/beat.js'
import { BEATS_FILE } from '../../shared/constants.js'

let root: string
let adapter: LocalAdapter
let beats: BeatService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-beats-'))
  adapter = new LocalAdapter(root)
  beats = new BeatService(adapter)
  await beats.load()
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('BeatService', () => {
  it('starts with a seeded board and no beats', () => {
    const file = beats.snapshot()
    expect(file.columns).toHaveLength(3)
    expect(file.beats).toEqual([])
  })

  it('appends new beats to the end of their column', async () => {
    await beats.create({ title: 'Opening' })
    await beats.create({ title: 'Inciting incident' })
    const ordered = beatsInColumn(beats.snapshot().beats, 'act-1')
    expect(ordered.map((beat) => beat.title)).toEqual(['Opening', 'Inciting incident'])
  })

  it('writes through to disk and reloads', async () => {
    await beats.create({ title: 'Opening', columnId: 'act-2' })
    const reloaded = new BeatService(adapter)
    const file = await reloaded.load()
    expect(file.beats).toHaveLength(1)
    expect(file.beats[0]!.columnId).toBe('act-2')
  })

  it('derives the sort key from the label on save', async () => {
    const created = await beats.create({ title: 'Opening' })
    const saved = await beats.save({ ...created, when: { label: 'Day 3', sort: null } })
    expect(saved.when.sort).toBe(3)
  })

  it('keeps a hand-placed beat where it was put when its label cannot be read', async () => {
    const created = await beats.create({ title: 'Opening' })
    const placed = await beats.save({ ...created, when: { label: 'Midsummer', sort: 42 } })
    expect(placed.when.sort).toBe(42)
    const renamed = await beats.save({ ...placed, when: { label: 'High summer', sort: 42 } })
    expect(renamed.when.sort).toBe(42)
  })

  it('round-trips links to documents and records', async () => {
    const created = await beats.create({ title: 'Opening' })
    await beats.save({
      ...created,
      docId: 'doc-1',
      blockIndex: 4,
      entityIds: ['e1', 'e2'],
      status: 'draft',
      summary: 'The storm arrives.'
    })
    const reloaded = new BeatService(adapter)
    const [beat] = (await reloaded.load()).beats
    expect(beat).toMatchObject({
      docId: 'doc-1',
      blockIndex: 4,
      entityIds: ['e1', 'e2'],
      status: 'draft',
      summary: 'The storm arrives.'
    })
  })

  it('hands out copies, so a caller cannot mutate the cache', async () => {
    const created = await beats.create({ title: 'Opening' })
    const snapshot = beats.snapshot()
    snapshot.beats[0]!.title = 'Tampered'
    expect(beats.get(created.id)?.title).toBe('Opening')
  })

  it('moves beats out of a deleted column rather than orphaning them', async () => {
    await beats.create({ title: 'Opening', columnId: 'act-3' })
    await beats.saveColumns([
      { id: 'act-1', name: 'Act I', order: 0 },
      { id: 'act-2', name: 'Act II', order: 1 }
    ])
    expect(beats.snapshot().beats[0]!.columnId).toBe('act-1')
  })

  it('renumbers columns to match the order they were given', async () => {
    const columns = await beats.saveColumns([
      { id: 'act-2', name: 'Act II', order: 99 },
      { id: 'act-1', name: 'Act I', order: 99 }
    ])
    expect(columns.map((column) => column.order)).toEqual([0, 1])
  })

  it('falls back to an empty board on a corrupt file, keeping the original', async () => {
    await beats.create({ title: 'Opening' })
    await fs.writeFile(path.join(root, BEATS_FILE), 'not json at all', 'utf8')

    const reloaded = new BeatService(adapter)
    expect((await reloaded.load()).beats).toEqual([])
    const kept = (await fs.readdir(path.join(root, '.thepub'))).filter((name) =>
      name.includes('beats.json.corrupt-')
    )
    expect(kept).toHaveLength(1)
  })

  it('applies concurrent saves in order', async () => {
    const created = await beats.create({ title: 'Opening' })
    await Promise.all([
      beats.save({ ...created, title: 'One' }),
      beats.save({ ...created, title: 'Two' }),
      beats.save({ ...created, title: 'Three' })
    ])
    const written = JSON.parse(await fs.readFile(path.join(root, BEATS_FILE), 'utf8')) as BeatFile
    expect(written.beats[0]!.title).toBe('Three')
  })
})

describe('deriveMoment', () => {
  it('lets a readable label win over the stored key', () => {
    expect(deriveMoment({ label: 'Day 9', sort: 1 }, { label: 'Day 1', sort: 1 })).toEqual({
      label: 'Day 9',
      sort: 9
    })
  })

  it('respects a key set by this write', () => {
    expect(deriveMoment({ label: 'Midsummer', sort: 7 }, { label: 'Midsummer', sort: 3 })).toEqual({
      label: 'Midsummer',
      sort: 7
    })
  })

  it('keeps the previous key when nothing says otherwise', () => {
    expect(deriveMoment({ label: 'Midsummer', sort: null }, { label: 'Midsummer', sort: 3 })).toEqual(
      { label: 'Midsummer', sort: 3 }
    )
  })
})
