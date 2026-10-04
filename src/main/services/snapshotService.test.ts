import { describe, it, expect } from 'vitest'
import { selectSnapshotsToKeep } from './snapshotService.js'
import { SNAPSHOT_MAX_PER_DOC } from '../../shared/constants.js'

const NOW = Date.parse('2026-08-14T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('selectSnapshotsToKeep', () => {
  it('keeps every snapshot from the last day', () => {
    const recent = [NOW - MINUTE, NOW - 30 * MINUTE, NOW - 5 * HOUR, NOW - 20 * HOUR]
    expect(selectSnapshotsToKeep(recent, NOW).size).toBe(4)
  })

  it('thins the last week down to one per hour', () => {
    const sameHour = [NOW - 3 * DAY + 40 * MINUTE, NOW - 3 * DAY + 20 * MINUTE, NOW - 3 * DAY + 10 * MINUTE]
    const keep = selectSnapshotsToKeep(sameHour, NOW)
    expect(keep.size).toBe(1)
    // The newest of the bucket is the one worth keeping.
    expect(keep.has(NOW - 3 * DAY + 40 * MINUTE)).toBe(true)
  })

  it('buckets by clock hour, so snapshots either side of the hour both survive', () => {
    const acrossBoundary = [NOW - 3 * DAY, NOW - 3 * DAY - 5 * MINUTE]
    expect(selectSnapshotsToKeep(acrossBoundary, NOW).size).toBe(2)
  })

  it('thins anything older than a week down to one per day', () => {
    const old = [NOW - 30 * DAY, NOW - 30 * DAY - HOUR, NOW - 30 * DAY - 2 * HOUR]
    expect(selectSnapshotsToKeep(old, NOW).size).toBe(1)
  })

  it('never keeps more than the per-document cap', () => {
    const many = Array.from({ length: 400 }, (_unused, index) => NOW - index * MINUTE)
    expect(selectSnapshotsToKeep(many, NOW).size).toBeLessThanOrEqual(SNAPSHOT_MAX_PER_DOC)
  })

  it('handles an empty history', () => {
    expect(selectSnapshotsToKeep([], NOW).size).toBe(0)
  })
})

describe('SnapshotService on disk', () => {
  async function setup() {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const { LocalAdapter } = await import('../vfs/localAdapter.js')
    const { SnapshotService } = await import('./snapshotService.js')
    const { SNAPSHOTS_DIR, FORMAT_VERSIONS } = await import('../../shared/constants.js')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-snapshots-'))
    const adapter = new LocalAdapter(root)
    const dir = path.join(root, SNAPSHOTS_DIR, 'doc-1')
    await fs.mkdir(dir, { recursive: true })
    return { fs, path, root, adapter, dir, snapshots: new SnapshotService(adapter), version: FORMAT_VERSIONS.document }
  }

  it('lists and prunes only files it named, leaving anything else alone', async () => {
    const { fs, path, root, adapter, dir, snapshots } = await setup()
    try {
      await fs.writeFile(path.join(dir, 'notes-from-me.json'), '{}')
      expect(await snapshots.list('doc-1')).toEqual([])
      await snapshots.prune('doc-1')
      expect(await fs.readdir(dir)).toEqual(['notes-from-me.json'])
    } finally {
      await adapter.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to restore a version a newer build saved', async () => {
    const { fs, path, root, adapter, dir, snapshots, version } = await setup()
    try {
      await fs.writeFile(
        path.join(dir, '2026-01-01T00-00-00-000Z.json'),
        JSON.stringify({ formatVersion: version + 1, docId: 'doc-1', title: 'x', content: { type: 'doc', content: [] } })
      )
      await expect(snapshots.read('doc-1', '2026-01-01T00:00:00.000Z')).rejects.toThrow(/newer version/)
    } finally {
      await adapter.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
