import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { StatsService } from './statsService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import type { AuthorProfile } from '../../shared/model/author.js'

let root: string
let adapter: LocalAdapter
let stats: StatsService

const ME: AuthorProfile = { id: 'author-1', name: 'A. Writer', color: '#000000' }

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-stats-'))
  adapter = new LocalAdapter(root)
  stats = new StatsService(adapter, () => ME)
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('StatsService', () => {
  it('starts empty', async () => {
    expect(await stats.all()).toEqual([])
  })

  it('accumulates gross added/removed and net for a day', async () => {
    await stats.record({ date: '2026-01-01', docId: 'doc-1', added: 100, removed: 0, net: 100, minutes: 5 })
    await stats.record({ date: '2026-01-01', docId: 'doc-1', added: 0, removed: 30, net: -30, minutes: 8 })
    const [day] = await stats.all()
    expect(day).toEqual({
      date: '2026-01-01',
      added: 100,
      removed: 30,
      net: 70,
      minutes: 8,
      byDoc: { 'doc-1': 70 }
    })
  })

  it('keeps per-document net separate in byDoc', async () => {
    await stats.record({ date: '2026-01-01', docId: 'doc-1', added: 100, removed: 0, net: 100, minutes: 3 })
    await stats.record({ date: '2026-01-01', docId: 'doc-2', added: 50, removed: 0, net: 50, minutes: 3 })
    const [day] = await stats.all()
    expect(day!.byDoc).toEqual({ 'doc-1': 100, 'doc-2': 50 })
  })

  it('does not flush until asked', async () => {
    await stats.record({ date: '2026-01-01', docId: 'doc-1', added: 10, removed: 0, net: 10, minutes: 1 })
    const exists = await fs
      .stat(path.join(root, '.thepub', 'stats', 'author-1.json'))
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  it('flush writes the file under this author\'s id', async () => {
    await stats.record({ date: '2026-01-01', docId: 'doc-1', added: 10, removed: 0, net: 10, minutes: 1 })
    await stats.flush()
    const raw = await fs.readFile(path.join(root, '.thepub', 'stats', 'author-1.json'), 'utf8')
    const file = JSON.parse(raw)
    expect(file.days).toHaveLength(1)
    expect(file.days[0].date).toBe('2026-01-01')
  })

  it('a second author writes to their own file', async () => {
    const other = new StatsService(adapter, () => ({ id: 'author-2', name: 'B', color: '#111' }))
    await stats.record({ date: '2026-01-01', docId: 'doc-1', added: 10, removed: 0, net: 10, minutes: 1 })
    await other.record({ date: '2026-01-01', docId: 'doc-1', added: 20, removed: 0, net: 20, minutes: 2 })
    await stats.flush()
    await other.flush()
    const mine = JSON.parse(await fs.readFile(path.join(root, '.thepub', 'stats', 'author-1.json'), 'utf8'))
    const theirs = JSON.parse(await fs.readFile(path.join(root, '.thepub', 'stats', 'author-2.json'), 'utf8'))
    expect(mine.days[0].added).toBe(10)
    expect(theirs.days[0].added).toBe(20)
  })

  it('a simulated year of writing produces 365 rows, not an event log', async () => {
    const start = new Date(2025, 0, 1)
    for (let i = 0; i < 365; i++) {
      const date = new Date(start)
      date.setDate(date.getDate() + i)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      // A few deltas within the same day, as a real writing session would emit.
      await stats.record({ date: key, docId: 'doc-1', added: 200, removed: 0, net: 200, minutes: 10 })
      await stats.record({ date: key, docId: 'doc-1', added: 0, removed: 20, net: -20, minutes: 15 })
    }
    const days = await stats.all()
    expect(days).toHaveLength(365)
    expect(days.every((day) => day.added === 200 && day.removed === 20)).toBe(true)
  })

  it('loads back what was flushed', async () => {
    await stats.record({ date: '2026-02-02', docId: 'doc-9', added: 42, removed: 1, net: 41, minutes: 4 })
    await stats.flush()
    const reloaded = new StatsService(adapter, () => ME)
    const days = await reloaded.all()
    expect(days).toHaveLength(1)
    expect(days[0]!.date).toBe('2026-02-02')
    expect(days[0]!.added).toBe(42)
  })

  it('recovers from a corrupt file rather than failing every future write', async () => {
    await adapter.mkdir('.thepub/stats').catch(() => {})
    await adapter.writeFileAtomic('.thepub/stats/author-1.json', Buffer.from('not json'))
    await stats.record({ date: '2026-01-01', docId: 'doc-1', added: 5, removed: 0, net: 5, minutes: 1 })
    const days = await stats.all()
    expect(days).toHaveLength(1)
  })
})
