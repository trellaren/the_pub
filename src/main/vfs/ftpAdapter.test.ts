import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FtpAdapter, type FtpConnection } from './ftpAdapter.js'
import { startFtpServer, type FtpTestServer } from './ftpTestServer.js'
import { pollingWatch } from './pollingWatcher.js'
import type { FileChangeEvent } from '../../shared/model/vfs.js'

/**
 * `FtpAdapter` against a real FTP server.
 *
 * The mirror of `sftpAdapter.test.ts`, deliberately the same shape so the two
 * backends are proven the same way rather than one being trusted because the
 * other was tested. `e2e/remote.spec.ts` has driven the whole app over FTP
 * since Phase 7, but that suite only ever exercises the happy path an author
 * walks; nothing has tested this adapter on its own, and the gap is exactly
 * where its SFTP sibling was found to be reporting an unreachable server as an
 * absent file.
 *
 * The shared logic every remote backend inherits is covered in
 * `remoteAdapter.test.ts` against an in-memory backend. What is tested here is
 * what is specific to FTP: the eight primitives, path mapping, the single
 * command queue, reconnection and authentication.
 */

const PASSWORD = 'a good long passphrase'
const USER = 'author'

let server: FtpTestServer
let serverRoot = ''
let area = ''
let adapters: FtpAdapter[] = []

beforeAll(async () => {
  serverRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pub-ftp-unit-'))
  server = await startFtpServer(serverRoot, { user: USER, password: PASSWORD })
})

afterAll(async () => {
  await server.close()
  await fsp.rm(serverRoot, { recursive: true, force: true }).catch(() => {})
})

/** Each test gets its own directory on the server, so none can disturb another. */
beforeEach(async ({ task }) => {
  area = `area-${task.id.replace(/[^a-z0-9]/gi, '-')}`
  await fsp.mkdir(path.join(serverRoot, area), { recursive: true })
})

afterEach(async () => {
  await Promise.all(adapters.map((adapter) => adapter.dispose()))
  adapters = []
})

function connect(overrides: Partial<FtpConnection> = {}): FtpAdapter {
  const adapter = new FtpAdapter({
    host: '127.0.0.1',
    port: server.port,
    user: USER,
    password: PASSWORD,
    secure: false,
    remotePath: area,
    ...overrides
  })
  adapters.push(adapter)
  return adapter
}

/** A path inside this test's own directory, as the server sees it on disk. */
function onDisk(...parts: string[]): string {
  return path.join(serverRoot, area, ...parts)
}

describe('listing', () => {
  it('reports names, kinds and sizes', async () => {
    await fsp.writeFile(onDisk('chapter-01.pubdoc'), 'twelve bytes')
    await fsp.mkdir(onDisk('notes'))

    const listing = await connect().list('')

    expect(listing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'chapter-01.pubdoc', path: 'chapter-01.pubdoc', kind: 'file', size: 12 }),
        expect.objectContaining({ name: 'notes', path: 'notes', kind: 'dir' })
      ])
    )
    expect(listing).toHaveLength(2)
  })

  it('omits the . and .. entries a server may send', async () => {
    await fsp.writeFile(onDisk('only.txt'), 'x')
    expect((await connect().list('')).map((entry) => entry.name)).toEqual(['only.txt'])
  })

  it('lists a subdirectory with paths relative to the project, not the server', async () => {
    await fsp.mkdir(onDisk('part-one'))
    await fsp.writeFile(onDisk('part-one', 'scene.pubdoc'), 'x')

    const listing = await connect().list('part-one')

    expect(listing).toHaveLength(1)
    // The configured remote path is the project root; it must not appear in a
    // path handed back, or every consumer above would build wrong URIs.
    expect(listing[0]!.path).toBe('part-one/scene.pubdoc')
    expect(listing[0]!.path).not.toContain(area)
  })

  /*
   * FTP has no single time format. The default `ls` listing carries minutes for
   * a recent file and only a year for an old one, so this asserts what the
   * protocol can actually carry rather than an exact stamp — and the point that
   * matters is that it is milliseconds since the epoch, not seconds, which is
   * the mistake the SFTP backend had to be corrected for.
   */
  it('reports mtimes in milliseconds', async () => {
    await fsp.writeFile(onDisk('recent.txt'), 'x')
    const [entry] = await connect().list('')

    expect(entry!.mtime).toBeGreaterThan(Date.now() - 5 * 60_000)
    expect(entry!.mtime).toBeLessThan(Date.now() + 5 * 60_000)
  })
})

describe('stat', () => {
  it('describes a file and a directory', async () => {
    await fsp.writeFile(onDisk('file.txt'), 'four')
    await fsp.mkdir(onDisk('dir'))
    const adapter = connect()

    expect(await adapter.stat('file.txt')).toMatchObject({ name: 'file.txt', kind: 'file', size: 4 })
    expect(await adapter.stat('dir')).toMatchObject({ name: 'dir', kind: 'dir' })
  })

  it('returns null for a name that is not in its directory', async () => {
    expect(await connect().stat('absent.txt')).toBeNull()
  })

  /*
   * A path under a directory that does not exist is absent, not an error — and
   * this is the case that has to work before anything else can. Opening a
   * project asks about `.thepub/project.json` before `.thepub` has been created,
   * so a backend that called this a failure could never scaffold a new project
   * on a server at all.
   */
  it('returns null for a path whose directory does not exist either', async () => {
    expect(await connect().stat('nothing/at/all.txt')).toBeNull()
  })

  /*
   * But absence has to be something the *server* said, which is the distinction
   * the whole of `isMissing` exists to draw. A stat that wrongly reports absence
   * makes `RemoteAdapter.delete` return success without deleting anything —
   * that is how a chapter leaves the file tree while sitting safely on a server
   * nobody can reach, and it is the defect this backend carried until now.
   */
  it('fails rather than claiming absence when the server cannot be reached', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pub-ftp-stat-down-'))
    const doomed = await startFtpServer(root, { user: USER, password: PASSWORD })
    await fsp.writeFile(path.join(root, 'chapter.pubdoc'), 'x')

    const adapter = connect({ port: doomed.port, remotePath: '' })
    expect(await adapter.stat('chapter.pubdoc')).not.toBeNull()
    await doomed.close()

    await expect(adapter.stat('chapter.pubdoc')).rejects.toThrow()
    await fsp.rm(root, { recursive: true, force: true })
  })

  /* Nor may an authentication failure read as an empty server. */
  it('fails rather than claiming absence when the password is wrong', async () => {
    await expect(connect({ password: 'not the password' }).stat('anything.txt')).rejects.toThrow()
  })

  it('names the parent directory of a nested path', async () => {
    await fsp.mkdir(onDisk('deep'))
    await fsp.writeFile(onDisk('deep', 'file.txt'), 'x')
    expect(await connect().stat('deep/file.txt')).toMatchObject({ name: 'file.txt', path: 'deep/file.txt' })
  })
})

describe('reading and writing', () => {
  it('round-trips text', async () => {
    const adapter = connect()
    await adapter.writeFile('chapter.pubdoc', Buffer.from('Once upon a time — a dash.', 'utf8'))
    expect(await fsp.readFile(onDisk('chapter.pubdoc'), 'utf8')).toBe('Once upon a time — a dash.')
    expect((await adapter.readFile('chapter.pubdoc')).toString('utf8')).toBe('Once upon a time — a dash.')
  })

  /*
   * Bigger than one transfer buffer, and every byte value present. A .docx
   * export or an imported image goes through this path, and a truncation or an
   * ASCII-mode mangling would be invisible against short text — FTP has a text
   * transfer mode that rewrites line endings, and hitting it would corrupt every
   * binary the app stores.
   */
  it('round-trips a binary payload larger than one packet', async () => {
    const payload = Buffer.alloc(300_000)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 256

    const adapter = connect()
    await adapter.writeFile('cover.png', payload)

    expect(await adapter.readFile('cover.png')).toEqual(payload)
    expect((await fsp.stat(onDisk('cover.png'))).size).toBe(payload.length)
  })

  it('creates missing parent directories on the way', async () => {
    await connect().writeFile('act-one/scene-two/beat.pubdoc', Buffer.from('x'))
    expect(await fsp.readFile(onDisk('act-one', 'scene-two', 'beat.pubdoc'), 'utf8')).toBe('x')
  })

  it('truncates rather than overlaying when a file shrinks', async () => {
    const adapter = connect()
    await adapter.writeFile('draft.txt', Buffer.from('a very long first draft'))
    await adapter.writeFile('draft.txt', Buffer.from('short'))
    expect(await fsp.readFile(onDisk('draft.txt'), 'utf8')).toBe('short')
  })
})

describe('mkdir', () => {
  it('creates intermediate directories the server would not', async () => {
    await connect().mkdir('a/b/c')
    expect((await fsp.stat(onDisk('a', 'b', 'c'))).isDirectory()).toBe(true)
  })

  it('is untroubled by a directory that already exists', async () => {
    const adapter = connect()
    await adapter.mkdir('a/b')
    await expect(adapter.mkdir('a/b')).resolves.toBeUndefined()
  })
})

describe('atomic writes', () => {
  it('replaces an existing file and leaves no temporary sibling', async () => {
    const adapter = connect()
    await adapter.writeFile('chapter.pubdoc', Buffer.from('first draft'))
    await adapter.writeFileAtomic('chapter.pubdoc', Buffer.from('second draft'))

    expect(await fsp.readFile(onDisk('chapter.pubdoc'), 'utf8')).toBe('second draft')
    expect(await fsp.readdir(onDisk())).toEqual(['chapter.pubdoc'])
  })

  it('writes a new file with no target to replace', async () => {
    await connect().writeFileAtomic('new.pubdoc', Buffer.from('x'))
    expect(await fsp.readdir(onDisk())).toEqual(['new.pubdoc'])
  })

  it('renames over an existing name', async () => {
    const adapter = connect()
    await adapter.writeFile('old-name.pubdoc', Buffer.from('the manuscript'))
    await adapter.writeFile('new-name.pubdoc', Buffer.from('the replacement'))

    await adapter.rename('new-name.pubdoc', 'old-name.pubdoc')

    expect(await fsp.readFile(onDisk('old-name.pubdoc'), 'utf8')).toBe('the replacement')
    // Neither the source nor the moved-aside previous version may survive.
    expect(await fsp.readdir(onDisk())).toEqual(['old-name.pubdoc'])
  })
})

describe('deleting', () => {
  it('removes a file', async () => {
    const adapter = connect()
    await adapter.writeFile('gone.txt', Buffer.from('x'))
    await adapter.delete('gone.txt')
    expect(await fsp.readdir(onDisk())).toEqual([])
  })

  it('empties a directory tree before removing it', async () => {
    const adapter = connect()
    await adapter.writeFile('tree/one.txt', Buffer.from('x'))
    await adapter.writeFile('tree/nested/two.txt', Buffer.from('x'))

    await adapter.delete('tree', { recursive: true })

    expect(await fsp.readdir(onDisk())).toEqual([])
  })

  it('says nothing about a path that was already gone', async () => {
    await expect(connect().delete('never-existed.txt')).resolves.toBeUndefined()
  })

  /*
   * The defect this whole file exists to catch.
   *
   * `RemoteAdapter.delete` stats first and returns silently when nothing is
   * there, which is right for a file already gone and badly wrong for a stat
   * that failed because the server was unreachable. `SftpAdapter.statRaw` had
   * exactly this shape and was corrected in Phase 10; the FTP one was left
   * because it needed a harness of its own, and this is that harness. Untreated,
   * deleting a chapter with the connection down reports success, the file tree
   * drops the row, and the chapter is still sitting on the server.
   */
  it('fails rather than claiming success when the server cannot be reached', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pub-ftp-down-'))
    const doomed = await startFtpServer(root, { user: USER, password: PASSWORD })
    await fsp.writeFile(path.join(root, 'chapter.pubdoc'), 'the manuscript')

    const adapter = connect({ port: doomed.port, remotePath: '' })
    expect(await adapter.list('')).toHaveLength(1)
    await doomed.close()

    await expect(adapter.delete('chapter.pubdoc')).rejects.toThrow()
    expect(await fsp.readdir(root)).toEqual(['chapter.pubdoc'])
    await fsp.rm(root, { recursive: true, force: true })
  })
})

describe('walk', () => {
  it('finds every file and skips ignored directories', async () => {
    const adapter = connect()
    await adapter.writeFile('chapter-01.pubdoc', Buffer.from('x'))
    await adapter.writeFile('part-two/chapter-02.pubdoc', Buffer.from('x'))
    await adapter.writeFile('.thepub/index.db', Buffer.from('x'))

    const found = await adapter.walk('', ['.thepub'])

    expect(found.map((entry) => entry.path).sort()).toEqual(['chapter-01.pubdoc', 'part-two/chapter-02.pubdoc'])
  })
})

/*
 * What the modification times are actually for.
 *
 * FTP has no change notifications, so the registry wraps every adapter in
 * `pollingWatch`, which decides that a file has changed by noticing that its
 * mtime differs from the last poll. That makes the mtime the whole mechanism:
 * while every file in a `LIST` listing reported the epoch — which is what
 * happened on any server without MLSD, meaning most of them — no edit made
 * anywhere else was ever noticed, and the search index never caught up with a
 * chapter revised on another machine.
 *
 * Driven through the real watcher against the real server rather than asserted
 * on the number, because the number is only interesting for what it enables.
 */
describe('change detection', () => {
  it('notices a file that has been modified since the last poll', async () => {
    const adapter = connect()
    await adapter.writeFile('chapter.pubdoc', Buffer.from('the first draft'))

    const seen: FileChangeEvent[] = []
    const stop = await pollingWatch(adapter, '', (events) => seen.push(...events), 150)
    try {
      // Let the first poll establish a baseline, so what follows is a change
      // rather than a discovery.
      await settle(400)
      seen.length = 0

      // Backdated rather than rewritten, because `ls` prints no seconds: two
      // writes inside the same minute are one reading, which is exactly why
      // `statRaw` asks `MDTM` where an exact answer matters.
      const earlier = new Date(Date.now() - 5 * 60_000)
      await fsp.writeFile(onDisk('chapter.pubdoc'), 'a revision from elsewhere')
      await fsp.utimes(onDisk('chapter.pubdoc'), earlier, earlier)

      await waitUntil(() => seen.some((event) => event.type === 'change' && event.path === 'chapter.pubdoc'))
    } finally {
      await stop()
    }
  })

  it('notices a file that has appeared and one that has gone', async () => {
    const adapter = connect()
    await adapter.writeFile('one.pubdoc', Buffer.from('x'))

    const seen: FileChangeEvent[] = []
    const stop = await pollingWatch(adapter, '', (events) => seen.push(...events), 150)
    try {
      await settle(400)
      seen.length = 0

      await adapter.writeFile('two.pubdoc', Buffer.from('x'))
      await waitUntil(() => seen.some((event) => event.type === 'add' && event.path === 'two.pubdoc'))

      await adapter.delete('one.pubdoc')
      await waitUntil(() => seen.some((event) => event.type === 'unlink' && event.path === 'one.pubdoc'))
    } finally {
      await stop()
    }
  })
})

describe('the session', () => {
  /*
   * One control connection, however many callers. FTP carries a single command
   * at a time and a second issued mid-transfer corrupts both, which is why
   * `ConnectionQueue` exists — this is the test that would notice if a call
   * slipped past it.
   */
  it('opens one connection for a burst of parallel calls', async () => {
    await fsp.writeFile(onDisk('a.txt'), 'x')
    const before = server.connectionCount()

    const adapter = connect()
    await Promise.all([
      adapter.list(''),
      adapter.stat('a.txt'),
      adapter.readFile('a.txt'),
      adapter.list(''),
      adapter.stat('a.txt')
    ])

    expect(server.connectionCount()).toBe(before + 1)
  })

  it('serialises concurrent writes rather than interleaving them', async () => {
    const adapter = connect()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => adapter.writeFile(`file-${i}.txt`, Buffer.from(String(i))))
    )

    expect(await fsp.readdir(onDisk())).toHaveLength(20)
    // Each landed intact: an interleaved command would have crossed two
    // transfers and left at least one file holding the other's bytes.
    for (let i = 0; i < 20; i++) {
      expect(await fsp.readFile(onDisk(`file-${i}.txt`), 'utf8')).toBe(String(i))
    }
  })

  /*
   * A server will close an idle session out from under a writer who has stepped
   * away for lunch, so `exec` reopens one and retries the command once. Unlike
   * the SFTP adapter, which fails the in-flight call and reconnects on the next
   * one, this one is expected to succeed through the drop.
   */
  it('reconnects and retries when the session has been dropped', async () => {
    await fsp.writeFile(onDisk('a.txt'), 'x')
    const adapter = connect()
    await adapter.list('')
    const before = server.connectionCount()

    await server.dropConnections()
    await settle()

    expect(await adapter.list('')).toHaveLength(1)
    expect(server.connectionCount()).toBe(before + 1)
  })

  it('closes the connection when disposed', async () => {
    const adapter = connect()
    await adapter.list('')
    await adapter.dispose()
    await settle()
    expect(server.openConnections()).toBe(0)
  })
})

describe('authentication', () => {
  it('fails readably on a wrong password', async () => {
    const adapter = connect({ password: 'not the password' })
    await expect(adapter.list('')).rejects.toThrow()
  })

  it('fails readably on a user the server does not know', async () => {
    const adapter = connect({ user: 'a stranger' })
    await expect(adapter.list('')).rejects.toThrow()
  })
})

/** Let the event loop deliver socket close events before asserting on them. */
function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Wait for a polled condition, failing with the reason rather than a timeout. */
async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await settle(50)
  }
  expect.fail('the watcher never reported the change')
}
