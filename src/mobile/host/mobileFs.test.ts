import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { MobileFs, MemoryBlobStore, IndexedDbBlobStore, type BlobStore, type FsChange } from './mobileFs.js'

const OPTIONS = {
  persistent: ['/userData', '/Documents'],
  eager: (path: string) => path.startsWith('/userData/')
}

async function open(store: BlobStore = new MemoryBlobStore()): Promise<MobileFs> {
  return MobileFs.open(store, OPTIONS)
}

describe('MobileFs', () => {
  it('reads back synchronously what was written synchronously', async () => {
    const fs = await open()
    fs.writeFileSync('/userData/app-state.json', '{"theme":"raven"}')
    expect(fs.readFileSync('/userData/app-state.json', 'utf8')).toBe('{"theme":"raven"}')
    expect(fs.statSync('/userData/app-state.json').size).toBe(17)
  })

  it('reports a missing file the way Node does, so callers that check the code still work', async () => {
    const fs = await open()
    expect(() => fs.readFileSync('/userData/missing.json')).toThrowError(/ENOENT/)
    await expect(fs.stat('/Documents/nothing')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to write into a folder that does not exist', async () => {
    const fs = await open()
    expect(() => fs.writeFileSync('/Documents/Novel/ch1.pubdoc', 'x')).toThrowError(/ENOENT/)
    fs.mkdirSync('/Documents/Novel/parts', { recursive: true })
    fs.writeFileSync('/Documents/Novel/parts/ch1.pubdoc', 'x')
    expect(fs.readdirSync('/Documents/Novel')).toEqual(['parts'])
  })

  it('replaces a file by renaming over it, which is what an atomic save does', async () => {
    const fs = await open()
    fs.writeFileSync('/userData/keys.json', 'old')
    fs.writeFileSync('/userData/keys.json.tmp-1', 'new')
    fs.renameSync('/userData/keys.json.tmp-1', '/userData/keys.json')
    expect(fs.readFileSync('/userData/keys.json', 'utf8')).toBe('new')
    expect(fs.existsSync('/userData/keys.json.tmp-1')).toBe(false)
  })

  it('moves a folder with everything in it', async () => {
    const fs = await open()
    fs.mkdirSync('/Documents/Novel/parts', { recursive: true })
    await fs.writeFile('/Documents/Novel/parts/ch1.pubdoc', 'one')
    await fs.rename('/Documents/Novel', '/Documents/Renamed')
    expect((await fs.readFile('/Documents/Renamed/parts/ch1.pubdoc', 'utf8'))).toBe('one')
    expect(fs.existsSync('/Documents/Novel')).toBe(false)
  })

  it('will not remove a folder that still holds something unless told to', async () => {
    const fs = await open()
    fs.mkdirSync('/Documents/Novel')
    fs.writeFileSync('/Documents/Novel/ch1.pubdoc', 'x')
    expect(() => fs.rmSync('/Documents/Novel')).toThrowError(/ENOTEMPTY/)
    fs.rmSync('/Documents/Novel', { recursive: true })
    expect(fs.existsSync('/Documents/Novel/ch1.pubdoc')).toBe(false)
    expect(() => fs.rmSync('/Documents/Novel', { force: true })).not.toThrow()
  })

  it('lists entries with their kind, for a caller walking a project', async () => {
    const fs = await open()
    fs.mkdirSync('/Documents/Novel/assets', { recursive: true })
    fs.writeFileSync('/Documents/Novel/ch1.pubdoc', 'x')
    const entries = (await fs.readdir('/Documents/Novel', { withFileTypes: true })) as { name: string; isDirectory(): boolean }[]
    expect(entries.map((entry) => [entry.name, entry.isDirectory()])).toEqual([
      ['assets', true],
      ['ch1.pubdoc', false]
    ])
  })

  it('gives two writes in the same millisecond different modification times', async () => {
    // The conflict check on save compares mtimes; equal ones would let a second writer through.
    const fs = await open()
    fs.mkdirSync('/Documents/Novel')
    fs.writeFileSync('/Documents/Novel/ch1.pubdoc', 'one')
    const first = fs.statSync('/Documents/Novel/ch1.pubdoc').mtimeMs
    fs.writeFileSync('/Documents/Novel/ch1.pubdoc', 'two')
    expect(fs.statSync('/Documents/Novel/ch1.pubdoc').mtimeMs).toBeGreaterThan(first)
  })

  it('tells a watcher what changed, a file before the folder it was in', async () => {
    const fs = await open()
    const seen: FsChange[] = []
    fs.onChange((change) => seen.push(change))
    fs.mkdirSync('/Documents/Novel')
    fs.writeFileSync('/Documents/Novel/ch1.pubdoc', 'x')
    fs.writeFileSync('/Documents/Novel/ch1.pubdoc', 'y')
    fs.rmSync('/Documents/Novel', { recursive: true })
    expect(seen).toEqual([
      { kind: 'addDir', path: '/Documents/Novel' },
      { kind: 'add', path: '/Documents/Novel/ch1.pubdoc' },
      { kind: 'change', path: '/Documents/Novel/ch1.pubdoc' },
      { kind: 'unlink', path: '/Documents/Novel/ch1.pubdoc' },
      { kind: 'unlinkDir', path: '/Documents/Novel' }
    ])
  })

  it('keeps what is outside the persistent roots in memory only', async () => {
    const store = new MemoryBlobStore()
    const fs = await open(store)
    fs.mkdirSync('/tmp')
    fs.writeFileSync('/tmp/picked.docx', 'bytes')
    await fs.flush()
    expect((await store.entries()).map(([path]) => path)).not.toContain('/tmp/picked.docx')
    expect(fs.readFileSync('/tmp/picked.docx', 'utf8')).toBe('bytes')
  })

  it('carries the bytes along when a file moves from memory into storage', async () => {
    const store = new MemoryBlobStore()
    const fs = await open(store)
    fs.mkdirSync('/tmp')
    fs.mkdirSync('/Documents/Novel')
    fs.writeFileSync('/tmp/import.pubdoc', 'imported')
    await fs.rename('/tmp/import.pubdoc', '/Documents/Novel/import.pubdoc')
    const reopened = await open(store)
    expect(await reopened.readFile('/Documents/Novel/import.pubdoc', 'utf8')).toBe('imported')
  })
})

describe.each([
  ['a memory store', async (): Promise<BlobStore> => new MemoryBlobStore()],
  ['IndexedDB', async (): Promise<BlobStore> => IndexedDbBlobStore.open(`test-${Math.random()}`)]
])('MobileFs across a restart, on %s', (_name, create) => {
  it('finds everything again, and can read app data synchronously straight away', async () => {
    const store = await create()
    const first = await open(store)
    first.writeFileSync('/userData/app-state.json', '{"recent":[]}')
    first.mkdirSync('/Documents/Novel/assets', { recursive: true })
    await first.writeFile('/Documents/Novel/assets/cover.png', new Uint8Array([137, 80, 78, 71]))
    await first.flush()

    const second = await open(store)
    expect(second.readFileSync('/userData/app-state.json', 'utf8')).toBe('{"recent":[]}')
    expect(second.readdirSync('/Documents/Novel')).toEqual(['assets'])
    expect([...((await second.readFile('/Documents/Novel/assets/cover.png')) as Uint8Array)]).toEqual([137, 80, 78, 71])
  })

  it('does not hold a project file in memory, and still refuses to pretend it can read it synchronously', async () => {
    const store = await create()
    const fs = await open(store)
    fs.mkdirSync('/Documents/Novel')
    await fs.writeFile('/Documents/Novel/ch1.pubdoc', 'x')
    expect(() => fs.readFileSync('/Documents/Novel/ch1.pubdoc')).toThrowError(/synchronously/)
  })

  it('forgets what was deleted and follows what was renamed', async () => {
    const store = await create()
    const first = await open(store)
    first.mkdirSync('/Documents/Novel')
    await first.writeFile('/Documents/Novel/a.pubdoc', 'a')
    await first.writeFile('/Documents/Novel/b.pubdoc', 'b')
    await first.rm('/Documents/Novel/a.pubdoc')
    await first.rename('/Documents/Novel/b.pubdoc', '/Documents/Novel/c.pubdoc')

    const second = await open(store)
    expect(second.readdirSync('/Documents/Novel')).toEqual(['c.pubdoc'])
    expect(await second.readFile('/Documents/Novel/c.pubdoc', 'utf8')).toBe('b')
  })
})
