import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SourceService } from './sourceService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { SOURCES_FILE, FORMAT_VERSIONS } from '../../shared/constants.js'
import { sourceFileSchema, type CslItem } from '../../shared/model/source.js'

let root: string
let adapter: LocalAdapter
let sources: SourceService

const book = (id: string, title: string): CslItem => ({ id, type: 'book', title })

async function onDisk(): Promise<CslItem[]> {
  const raw = await fs.readFile(path.join(root, SOURCES_FILE), 'utf8')
  return sourceFileSchema.parse(JSON.parse(raw)).sources
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-sources-'))
  adapter = new LocalAdapter(root)
  sources = new SourceService(adapter)
  await sources.load()
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('SourceService.merge', () => {
  it('adds new sources and writes them through', async () => {
    const result = await sources.merge([book('a', 'Alpha'), book('b', 'Beta')])

    expect(result).toEqual({ added: 2, replaced: 0, skipped: 0 })
    expect((await onDisk()).map((item) => item.id)).toEqual(['a', 'b'])
  })

  /*
   * Importing the same file twice is an ordinary thing to do, and doubling the
   * library for it would be the kind of failure someone has to clean up by
   * hand.
   */
  it('replaces rather than duplicating a source it already holds', async () => {
    await sources.merge([book('a', 'Alpha')])
    const result = await sources.merge([book('a', 'Alpha, corrected')])

    expect(result).toEqual({ added: 0, replaced: 1, skipped: 0 })
    const stored = await onDisk()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.title).toBe('Alpha, corrected')
  })

  it('counts a mixed import as part added and part replaced', async () => {
    await sources.merge([book('a', 'Alpha')])
    expect(await sources.merge([book('a', 'Alpha again'), book('c', 'Gamma')])).toEqual({
      added: 1,
      replaced: 1,
      skipped: 0
    })
  })

  // One bad record must not cost someone the rest of a four-hundred-entry file.
  it('skips an unusable record and keeps the rest', async () => {
    const result = await sources.merge([
      book('a', 'Alpha'),
      { type: 'book', title: 'No id at all' } as CslItem,
      book('c', 'Gamma')
    ])

    expect(result).toEqual({ added: 2, replaced: 0, skipped: 1 })
    expect((await onDisk()).map((item) => item.id)).toEqual(['a', 'c'])
  })

  it('leaves hand-created sources alone', async () => {
    const created = await sources.create('article-journal')
    await sources.merge([book('imported', 'Imported')])

    expect((await onDisk()).map((item) => item.id)).toEqual([created.id, 'imported'])
  })

  it('writes nothing when there is nothing to merge', async () => {
    expect(await sources.merge([])).toEqual({ added: 0, replaced: 0, skipped: 0 })
    await expect(fs.stat(path.join(root, SOURCES_FILE))).rejects.toThrow()
  })

  /*
   * `merge` loads before it writes. Without that, a merge arriving before
   * anything had read the file would flush a library containing only the
   * imported entries, silently discarding what was already there.
   */
  it('does not discard sources written before this service read the file', async () => {
    await sources.merge([book('existing', 'Already here')])

    const second = new SourceService(adapter)
    await second.merge([book('fresh', 'Newly imported')])

    expect((await onDisk()).map((item) => item.id)).toEqual(['existing', 'fresh'])
  })

  it('stamps the current format version on what it writes', async () => {
    await sources.merge([book('a', 'Alpha')])
    const raw = JSON.parse(await fs.readFile(path.join(root, SOURCES_FILE), 'utf8'))
    expect(raw.formatVersion).toBe(FORMAT_VERSIONS.sources)
  })
})
