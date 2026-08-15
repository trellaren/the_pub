import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SftpAdapter, type SftpConnection } from './sftpAdapter.js'
import { startSftpServer, type TestServer } from './sftpTestServer.js'

/**
 * `SftpAdapter` against a real SFTP server.
 *
 * Everything here could be faked, and faking it would prove nothing: this
 * adapter is protocol handling almost end to end, so a fake would only confirm
 * that the fake agrees with itself. `sftpTestServer` stands up an `ssh2.Server`
 * over a temporary directory, so the files that appear on disk are the
 * assertion — the same shape as the FTP suite in `e2e/remote.spec.ts`.
 *
 * The shared logic every remote backend inherits is covered separately, in
 * `remoteAdapter.test.ts`, against an in-memory backend. What is tested here is
 * the part that is specific to SSH: the eight primitives, the unit conversion,
 * path mapping, session handling and authentication.
 */

const PASSWORD = 'a good long passphrase'

let server: TestServer
let serverRoot = ''
let area = ''
let adapters: SftpAdapter[] = []

beforeAll(async () => {
  serverRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pub-sftp-'))
  server = await startSftpServer(serverRoot, { password: PASSWORD })
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

function connect(overrides: Partial<SftpConnection> = {}): SftpAdapter {
  const adapter = new SftpAdapter({
    host: '127.0.0.1',
    port: server.port,
    user: 'author',
    password: PASSWORD,
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

    expect(listing).toEqual([
      expect.objectContaining({ name: 'chapter-01.pubdoc', path: 'chapter-01.pubdoc', kind: 'file', size: 12 }),
      expect.objectContaining({ name: 'notes', path: 'notes', kind: 'dir' })
    ])
  })

  /*
   * SFTP reports times in seconds and everything above the adapter works in
   * milliseconds. The conversion is one `* 1000` in each of two methods, and
   * getting it wrong would not throw — it would put every file's timestamp
   * fifty thousand years in the future, where the only symptom is that
   * snapshots and external-change detection quietly stop behaving.
   */
  it('converts mtimes from seconds to milliseconds', async () => {
    const when = new Date('2019-03-04T05:06:07Z')
    await fsp.writeFile(onDisk('dated.txt'), 'x')
    await fsp.utimes(onDisk('dated.txt'), when, when)

    const adapter = connect()
    const [entry] = await adapter.list('')
    expect(entry!.mtime).toBe(when.getTime())
    expect((await adapter.stat('dated.txt'))!.mtime).toBe(when.getTime())
  })

  it('omits the . and .. entries a server may send', async () => {
    await fsp.writeFile(onDisk('only.txt'), 'x')
    const listing = await connect().list('')
    expect(listing.map((entry) => entry.name)).toEqual(['only.txt'])
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
})

describe('stat', () => {
  it('describes a file and a directory', async () => {
    await fsp.writeFile(onDisk('file.txt'), 'four')
    await fsp.mkdir(onDisk('dir'))
    const adapter = connect()

    expect(await adapter.stat('file.txt')).toMatchObject({ name: 'file.txt', kind: 'file', size: 4 })
    expect(await adapter.stat('dir')).toMatchObject({ name: 'dir', kind: 'dir' })
  })

  it('returns null for a path that is not there', async () => {
    expect(await connect().stat('nothing/at/all.txt')).toBeNull()
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
   * Bigger than one SFTP packet, and every byte value present. A .docx export
   * or an imported image goes through this path, and a length or offset error
   * in the chunked read/write loop would be invisible against short ASCII.
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

  /*
   * The move-aside path in `RemoteAdapter`, run for the first time against a
   * server that genuinely refuses to rename over an existing file rather than
   * an in-memory stand-in that pretends to. This is what stops a failed save
   * from destroying the previous draft, so it is worth watching it work here
   * as well as in the unit test that describes it.
   */
  it('renames over an existing name on a server that refuses to', async () => {
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
   * `RemoteAdapter.delete` stats first and returns silently when nothing is
   * there. That is right for a file already gone and badly wrong for a stat
   * that failed because the server was unreachable, which is what `statRaw`
   * used to report as absence: the delete reported success, the file tree
   * dropped the row, and the chapter was still on the server.
   */
  it('fails rather than claiming success when the server cannot be reached', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pub-sftp-down-'))
    const doomed = await startSftpServer(root, { password: PASSWORD })
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

describe('the session', () => {
  /*
   * SSH servers count sessions against an account, and a project index opens a
   * burst of parallel calls the moment a project is opened. Without the shared
   * `connecting` promise each of those would open its own.
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

  it('interleaves concurrent requests rather than serialising them', async () => {
    const adapter = connect()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => adapter.writeFile(`file-${i}.txt`, Buffer.from(String(i))))
    )
    expect(await fsp.readdir(onDisk())).toHaveLength(20)
  })

  /*
   * The behaviour as it stands, pinned deliberately: `SftpAdapter` drops its
   * handles when the channel closes but has no retry wrapper, unlike
   * `FtpAdapter.exec` which reconnects once. So a call in flight when the
   * connection dies fails, and the *next* call reconnects. Whether the two
   * backends ought to agree is a real question, but one to settle with evidence
   * rather than fold into a testing phase.
   */
  it('reconnects on the next call after the connection drops', async () => {
    await fsp.writeFile(onDisk('a.txt'), 'x')
    const adapter = connect()
    await adapter.list('')
    const before = server.connectionCount()

    server.dropConnections()
    await settle()

    expect(await adapter.list('')).toHaveLength(1)
    expect(server.connectionCount()).toBe(before + 1)
  })

  /*
   * ssh2 abandons a request that was in flight when the channel died — no
   * callback, no error, nothing. An autosave interrupted by a dropped
   * connection therefore never finished and never failed; it waited forever,
   * and so did everything holding the document.
   */
  it('fails a request that was in flight when the connection dropped', async () => {
    const payload = Buffer.alloc(8_000_000, 7)
    await fsp.writeFile(onDisk('big.bin'), payload)

    const adapter = connect()
    await adapter.list('')

    const reading = adapter.readFile('big.bin')
    await settle(5)
    server.dropConnections()

    await expect(reading).rejects.toThrow(/connection to the server was lost/i)
  })

  it('closes the session when disposed, even mid-handshake', async () => {
    const adapter = connect()
    // No await: dispose lands while the handshake is still running, which used
    // to leave the socket open on the server with nothing referencing it.
    const inFlight = adapter.list('')
    await adapter.dispose()

    await expect(inFlight).rejects.toThrow()
    await settle()
    expect(server.openConnections()).toBe(0)
  })

  it('refuses to reopen a connection after it has been disposed', async () => {
    const adapter = connect()
    await adapter.list('')
    await adapter.dispose()
    await expect(adapter.list('')).rejects.toThrow(/closed/i)
  })
})

describe('authentication', () => {
  it('accepts a private key', async () => {
    await fsp.writeFile(onDisk('a.txt'), 'x')
    const adapter = connect({ password: undefined, privateKey: server.clientKey })
    expect(await adapter.list('')).toHaveLength(1)
  })

  it('fails readably on a wrong password', async () => {
    const adapter = connect({ password: 'not the password' })
    await expect(adapter.list('')).rejects.toThrow(/authentication/i)
  })

  it('fails readably on a key the server does not know', async () => {
    const other = await startSftpServer(serverRoot)
    try {
      const adapter = connect({ password: undefined, privateKey: other.clientKey })
      await expect(adapter.list('')).rejects.toThrow(/authentication/i)
    } finally {
      await other.close()
    }
  })
})

/** Let the event loop deliver socket close events before asserting on them. */
function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
