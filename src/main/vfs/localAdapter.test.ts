import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { LocalAdapter } from './localAdapter.js'
import { VfsPathError } from './paths.js'

let root: string
let adapter: LocalAdapter

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-test-'))
  adapter = new LocalAdapter(root)
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('LocalAdapter', () => {
  it('lists directories before files, each alphabetically', async () => {
    await adapter.mkdir('zeta')
    await adapter.writeFile('alpha.pubdoc', Buffer.from('a'))
    await adapter.writeFile('beta.pubdoc', Buffer.from('b'))
    const entries = await adapter.list('')
    expect(entries.map((entry) => entry.name)).toEqual(['zeta', 'alpha.pubdoc', 'beta.pubdoc'])
  })

  it('creates parent directories when writing', async () => {
    await adapter.writeFile('deep/nested/file.txt', Buffer.from('hi'))
    expect((await adapter.readFile('deep/nested/file.txt')).toString()).toBe('hi')
  })

  it('leaves no temporary file behind after an atomic write', async () => {
    await adapter.writeFileAtomic('chapter.pubdoc', Buffer.from('content'))
    const entries = await adapter.list('')
    expect(entries.map((entry) => entry.name)).toEqual(['chapter.pubdoc'])
    expect((await adapter.readFile('chapter.pubdoc')).toString()).toBe('content')
  })

  it('replaces an existing file atomically', async () => {
    await adapter.writeFileAtomic('chapter.pubdoc', Buffer.from('first'))
    await adapter.writeFileAtomic('chapter.pubdoc', Buffer.from('second'))
    expect((await adapter.readFile('chapter.pubdoc')).toString()).toBe('second')
    expect((await adapter.list('')).length).toBe(1)
  })

  it('refuses to read or write outside the project root', async () => {
    await expect(adapter.readFile('../escape.txt')).rejects.toThrow(VfsPathError)
    await expect(adapter.writeFile('../escape.txt', Buffer.from('x'))).rejects.toThrow(VfsPathError)
    await expect(adapter.list('..')).rejects.toThrow(VfsPathError)
  })

  it('reports null rather than throwing when statting a missing file', async () => {
    expect(await adapter.stat('nope.pubdoc')).toBeNull()
  })

  it('walks recursively while skipping ignored directories', async () => {
    await adapter.writeFile('manuscript/ch1.pubdoc', Buffer.from('1'))
    await adapter.writeFile('manuscript/part2/ch2.pubdoc', Buffer.from('2'))
    await adapter.writeFile('.thepub/index.db', Buffer.from('cache'))
    const files = await adapter.walk('', ['.thepub'])
    expect(files.map((file) => file.path).sort()).toEqual([
      'manuscript/ch1.pubdoc',
      'manuscript/part2/ch2.pubdoc'
    ])
  })

  it('moves a file into a directory that does not exist yet', async () => {
    await adapter.writeFile('draft.pubdoc', Buffer.from('x'))
    await adapter.rename('draft.pubdoc', 'archive/2026/draft.pubdoc')
    expect(await adapter.stat('draft.pubdoc')).toBeNull()
    expect((await adapter.readFile('archive/2026/draft.pubdoc')).toString()).toBe('x')
  })

  it('exposes mtimes so the indexer can detect changes', async () => {
    await adapter.writeFile('a.pubdoc', Buffer.from('1'))
    const before = await adapter.stat('a.pubdoc')
    await new Promise((resolve) => setTimeout(resolve, 12))
    await adapter.writeFile('a.pubdoc', Buffer.from('22'))
    const after = await adapter.stat('a.pubdoc')
    expect(after!.mtime).toBeGreaterThan(before!.mtime!)
  })
})
