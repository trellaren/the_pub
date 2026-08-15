import { describe, it, expect, beforeEach } from 'vitest'
import { RemoteAdapter, ConnectionQueue } from './remoteAdapter.js'
import type { VfsEntry, VfsCapabilities } from '../../shared/model/vfs.js'

/**
 * An in-memory backend, so the shared remote logic can be tested without a
 * server. `failRenameOverExisting` reproduces the behaviour real SFTP and FTP
 * servers have and POSIX does not.
 */
class FakeRemote extends RemoteAdapter {
  readonly caps: VfsCapabilities = {
    watch: false,
    atomicRename: true,
    caseSensitive: true,
    preservesMtime: false,
    fastStat: false
  }
  readonly root = 'fake://host/project'
  files = new Map<string, Buffer>()
  dirs = new Set<string>()
  failRenameOverExisting = true
  refuseRenameTo = new Set<string>()
  calls: string[] = []

  protected async listRaw(dir: string): Promise<VfsEntry[]> {
    const prefix = dir ? `${dir}/` : ''
    const names = new Set<string>()
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (!rest) continue
      names.add(rest.split('/')[0]!)
    }
    return [...names].map((name) => {
      const full = prefix + name
      return this.entry(dir, name, this.dirs.has(full), this.files.get(full)?.length ?? 0, 1)
    })
  }

  protected async statRaw(path: string): Promise<VfsEntry | null> {
    if (this.dirs.has(path)) return this.entry(dirOf(path), baseOf(path), true)
    const file = this.files.get(path)
    if (file) return this.entry(dirOf(path), baseOf(path), false, file.length, 1)
    return null
  }

  protected async readRaw(path: string): Promise<Buffer> {
    const file = this.files.get(path)
    if (!file) throw new Error(`No such file: ${path}`)
    return file
  }

  protected async writeRaw(path: string, data: Buffer): Promise<void> {
    this.calls.push(`write:${path}`)
    this.files.set(path, data)
  }

  protected async mkdirRaw(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`)
    this.dirs.add(path)
  }

  protected async renameRaw(from: string, to: string): Promise<void> {
    this.calls.push(`rename:${from}->${to}`)
    // A refusal that has nothing to do with the name being taken: a lock, a
    // permission, a retention rule. It outlives a delete of the destination.
    if (this.refuseRenameTo.has(to)) throw new Error('Access denied')
    if (this.failRenameOverExisting && (this.files.has(to) || this.dirs.has(to))) {
      throw new Error('Destination exists')
    }
    const file = this.files.get(from)
    if (file) {
      this.files.delete(from)
      this.files.set(to, file)
      return
    }
    if (!this.dirs.delete(from)) throw new Error(`No such path: ${from}`)
    this.dirs.add(to)
  }

  protected async removeFile(path: string): Promise<void> {
    this.calls.push(`unlink:${path}`)
    this.files.delete(path)
  }

  protected async removeDir(path: string): Promise<void> {
    this.calls.push(`rmdir:${path}`)
    this.dirs.delete(path)
  }

  async dispose(): Promise<void> {}
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}
function baseOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

let remote: FakeRemote

beforeEach(() => {
  remote = new FakeRemote()
})

describe('writeFileAtomic', () => {
  it('writes a temporary sibling and renames it over the target', async () => {
    await remote.writeFileAtomic('chapter.pubdoc', Buffer.from('one'))
    const temp = remote.calls.find((call) => call.startsWith('write:') && call.includes('.tmp-'))
    expect(temp).toBeTruthy()
    // The temp file is a sibling, so the rename stays inside one directory —
    // the only case a server is obliged to make atomic.
    expect(temp).not.toContain('/')
    expect((await remote.readFile('chapter.pubdoc')).toString()).toBe('one')
  })

  it('replaces an existing file on a server that refuses to rename over one', async () => {
    await remote.writeFileAtomic('chapter.pubdoc', Buffer.from('one'))
    remote.calls = []
    await remote.writeFileAtomic('chapter.pubdoc', Buffer.from('two'))

    expect((await remote.readFile('chapter.pubdoc')).toString()).toBe('two')
    // The fallback only runs after the direct rename is refused, and it moves
    // the previous version aside rather than deleting it.
    expect(remote.calls.filter((call) => call.startsWith('rename:'))).toHaveLength(3)
    expect(remote.calls).not.toContain('unlink:chapter.pubdoc')
    // Nothing is left over once the replacement is in place.
    expect([...remote.files.keys()]).toEqual(['chapter.pubdoc'])
  })

  it('keeps the previous version when the replacement cannot be put in place', async () => {
    // The reason the fallback moves aside instead of deleting: a rename can be
    // refused for reasons that have nothing to do with the name being taken —
    // a lock, a permission, a throttled account — and deleting first would
    // destroy a chapter that was on the server a moment ago.
    await remote.writeFileAtomic('chapter.pubdoc', Buffer.from('one'))
    remote.refuseRenameTo.add('chapter.pubdoc')

    await expect(remote.writeFileAtomic('chapter.pubdoc', Buffer.from('two'))).rejects.toThrow()
    const survivor = [...remote.files.keys()]
    expect(survivor).toHaveLength(1)
    expect(remote.files.get(survivor[0]!)!.toString()).toBe('one')
  })

  it('says where the previous version went when it could not be put back', async () => {
    await remote.writeFileAtomic('chapter.pubdoc', Buffer.from('one'))
    remote.refuseRenameTo.add('chapter.pubdoc')

    // A file called `chapter.pubdoc.old-01J…` and no error naming it is how an
    // author concludes the app ate their work.
    await expect(remote.writeFileAtomic('chapter.pubdoc', Buffer.from('two'))).rejects.toThrow(
      /chapter\.pubdoc\.old-/
    )
  })

  it('takes the direct path on a server that does replace', async () => {
    remote.failRenameOverExisting = false
    await remote.writeFileAtomic('chapter.pubdoc', Buffer.from('one'))
    remote.calls = []
    await remote.writeFileAtomic('chapter.pubdoc', Buffer.from('two'))
    expect(remote.calls.filter((call) => call.startsWith('rename:'))).toHaveLength(1)
    expect(remote.calls.some((call) => call.startsWith('unlink:chapter'))).toBe(false)
  })

  it('leaves no temporary file behind when the rename cannot be completed', async () => {
    remote.files.set('locked', Buffer.from('x'))
    remote.dirs.add('locked')
    // A directory in the way: rename fails, and the delete of a "file" that is
    // really a directory leaves the rename failing again.
    await expect(remote.writeFileAtomic('locked', Buffer.from('new'))).rejects.toThrow()
    expect([...remote.files.keys()].filter((key) => key.includes('.tmp-'))).toEqual([])
  })

  it('creates the parent directory before writing into it', async () => {
    await remote.writeFileAtomic('parts/one/chapter.pubdoc', Buffer.from('x'))
    expect(remote.calls).toContain('mkdir:parts')
    expect(remote.calls).toContain('mkdir:parts/one')
    expect(remote.files.has('parts/one/chapter.pubdoc')).toBe(true)
  })
})

describe('mkdir', () => {
  it('creates every missing segment, servers not doing it for us', async () => {
    await remote.mkdir('a/b/c')
    expect(remote.calls).toEqual(['mkdir:a', 'mkdir:a/b', 'mkdir:a/b/c'])
  })

  it('does nothing for directories that already exist', async () => {
    await remote.mkdir('a/b')
    remote.calls = []
    await remote.mkdir('a/b')
    expect(remote.calls).toEqual([])
  })

  it('tolerates another writer creating the directory first', async () => {
    const racing = new FakeRemote()
    // Fail the call but leave the directory there, as a server would.
    racing['mkdirRaw'] = async (path: string) => {
      racing.dirs.add(path)
      throw new Error('EEXIST')
    }
    await expect(racing.mkdir('a')).resolves.toBeUndefined()
  })

  it('ignores an empty path rather than making a directory called nothing', async () => {
    await remote.mkdir('')
    expect(remote.calls).toEqual([])
  })
})

describe('delete', () => {
  it('removes a file', async () => {
    await remote.writeFile('a.pubdoc', Buffer.from('x'))
    await remote.delete('a.pubdoc')
    expect(await remote.stat('a.pubdoc')).toBeNull()
  })

  it('empties a directory before removing it', async () => {
    await remote.writeFile('parts/one/a.pubdoc', Buffer.from('x'))
    await remote.delete('parts', { recursive: true })
    expect(await remote.stat('parts')).toBeNull()
    expect(remote.files.size).toBe(0)
  })

  it('does nothing for a path that is already gone', async () => {
    await expect(remote.delete('nope')).resolves.toBeUndefined()
  })
})

describe('walk', () => {
  beforeEach(async () => {
    await remote.writeFile('a.pubdoc', Buffer.from('x'))
    await remote.writeFile('parts/one/b.pubdoc', Buffer.from('x'))
    await remote.writeFile('.thepub/index.db', Buffer.from('x'))
  })

  it('finds files at every depth', async () => {
    const found = await remote.walk('', [])
    expect(found.map((entry) => entry.path).sort()).toEqual([
      '.thepub/index.db',
      'a.pubdoc',
      'parts/one/b.pubdoc'
    ])
  })

  it('skips ignored directories', async () => {
    const found = await remote.walk('', ['.thepub'])
    expect(found.map((entry) => entry.path).sort()).toEqual(['a.pubdoc', 'parts/one/b.pubdoc'])
  })

  it('keeps going when a directory cannot be read', async () => {
    const original = remote['listRaw'].bind(remote)
    remote['listRaw'] = async (dir: string) => {
      if (dir === 'parts/one') throw new Error('Permission denied')
      return original(dir)
    }
    const found = await remote.walk('', [])
    expect(found.map((entry) => entry.path)).toContain('a.pubdoc')
  })
})

describe('ConnectionQueue', () => {
  it('runs operations one at a time, in order', async () => {
    const queue = new ConnectionQueue()
    const order: string[] = []
    const slow = async (name: string, ms: number): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      order.push(name)
    }
    await Promise.all([
      queue.run(() => slow('first', 20)),
      queue.run(() => slow('second', 1)),
      queue.run(() => slow('third', 1))
    ])
    // Without the queue, 'second' would finish first and interleave with a
    // transfer still in flight on the same control connection.
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('keeps running after one operation fails', async () => {
    const queue = new ConnectionQueue()
    await expect(queue.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(queue.run(() => Promise.resolve('fine'))).resolves.toBe('fine')
  })
})
