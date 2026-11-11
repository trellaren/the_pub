import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { LocalAdapter, retryWhileLocked } from './localAdapter.js'
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

describe('retryWhileLocked', () => {
  /** An error shaped like the one Windows raises when a file is held open. */
  function locked(code: string): NodeJS.ErrnoException {
    const error = new Error(`${code}: operation not permitted, rename`) as NodeJS.ErrnoException
    error.code = code
    return error
  }

  it('succeeds once the other process lets go', async () => {
    // On Windows this is antivirus, the Search Indexer, or the OneDrive sync
    // client holding the file Quoth just wrote. Without the retry it surfaces
    // as a save error on a perfectly healthy document.
    let attempts = 0
    await retryWhileLocked(async () => {
      attempts += 1
      if (attempts < 3) throw locked('EPERM')
    })
    expect(attempts).toBe(3)
  })

  it('retries each of the codes Windows uses for it', async () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      let attempts = 0
      await retryWhileLocked(async () => {
        attempts += 1
        if (attempts < 2) throw locked(code)
      })
      expect(attempts).toBe(2)
    }
  })

  it('gives up rather than retrying forever', async () => {
    let attempts = 0
    await expect(
      retryWhileLocked(async () => {
        attempts += 1
        throw locked('EBUSY')
      })
    ).rejects.toThrow('EBUSY')
    expect(attempts).toBe(5)
  })

  it('rethrows a real error immediately', async () => {
    // A missing file is not going to appear if we wait, and retrying would turn
    // an instant failure into a slow one.
    let attempts = 0
    await expect(
      retryWhileLocked(async () => {
        attempts += 1
        throw locked('ENOENT')
      })
    ).rejects.toThrow('ENOENT')
    expect(attempts).toBe(1)
  })
})

describe('LocalAdapter symlink containment', () => {
  let outside: string

  beforeEach(async () => {
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-outside-'))
    await fs.writeFile(path.join(outside, 'secret.txt'), 'private')
    await fs.symlink(outside, path.join(root, 'linked'), 'dir')
  })

  afterEach(async () => {
    await fs.rm(outside, { recursive: true, force: true })
  })

  it('refuses to read, list or stat through a link out of the root', async () => {
    await expect(adapter.readFile('linked/secret.txt')).rejects.toBeInstanceOf(VfsPathError)
    await expect(adapter.list('linked')).rejects.toBeInstanceOf(VfsPathError)
    expect(await adapter.stat('linked/secret.txt')).toBeNull()
  })

  it('refuses to write, create, rename or delete through a link out of the root', async () => {
    await expect(adapter.writeFile('linked/new.txt', Buffer.from('x'))).rejects.toBeInstanceOf(VfsPathError)
    await expect(adapter.writeFileAtomic('linked/secret.txt', Buffer.from('x'))).rejects.toBeInstanceOf(VfsPathError)
    await expect(adapter.writeFile('linked/deeper/new.txt', Buffer.from('x'))).rejects.toBeInstanceOf(VfsPathError)
    await expect(adapter.mkdir('linked/sub')).rejects.toBeInstanceOf(VfsPathError)
    await adapter.writeFile('mine.txt', Buffer.from('m'))
    await expect(adapter.rename('mine.txt', 'linked/moved.txt')).rejects.toBeInstanceOf(VfsPathError)
    await expect(adapter.rename('linked/secret.txt', 'stolen.txt')).rejects.toBeInstanceOf(VfsPathError)
    await expect(adapter.delete('linked/secret.txt')).rejects.toBeInstanceOf(VfsPathError)
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('private')
    expect(await fs.readdir(outside)).toEqual(['secret.txt'])
  })

  it('refuses to write through a file link, even a dangling one', async () => {
    await fs.symlink(path.join(outside, 'planted.txt'), path.join(root, 'dangling.txt'))
    await expect(adapter.writeFile('dangling.txt', Buffer.from('x'))).rejects.toBeInstanceOf(VfsPathError)
    expect(await fs.readdir(outside)).toEqual(['secret.txt'])
  })

  it('still allows links that stay inside the root', async () => {
    await adapter.writeFile('real/chapter.txt', Buffer.from('hi'))
    await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'), 'dir')
    expect((await adapter.readFile('alias/chapter.txt')).toString()).toBe('hi')
    await adapter.writeFile('alias/other.txt', Buffer.from('ok'))
    expect((await adapter.readFile('real/other.txt')).toString()).toBe('ok')
  })

  it('deletes the link itself, not what it points to', async () => {
    await adapter.delete('linked', { recursive: true })
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('private')
  })
})
