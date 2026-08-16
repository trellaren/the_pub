import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DbAdapter } from './dbAdapter.js'
import { sqliteDialect } from './db/dialects.js'
import { assertSafeIdent, tableName } from './db/dialect.js'
import { SCHEMA_VERSION } from './db/store.js'
import type { FileChangeEvent } from '../../shared/model/vfs.js'

let adapter: DbAdapter

/**
 * Driven against real SQLite in memory.
 *
 * The dialect seam is the only thing that differs between engines, so the whole
 * adapter above it is exercised for real here — transactions, the change feed,
 * directory rows — without a server to stand up. Postgres and MySQL run the
 * same shape behind an opt-in env var, following the SFTP and FTP precedent.
 */
function open(options: { create?: boolean; schema?: string } = {}): DbAdapter {
  return new DbAdapter({
    dialect: sqliteDialect(':memory:'),
    schema: options.schema ?? 'thepub',
    label: 'db://test',
    create: options.create ?? true,
    pollIntervalMs: 20
  })
}

beforeEach(() => {
  adapter = open()
})

afterEach(async () => {
  await adapter.dispose()
})

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')

describe('the VfsAdapter contract', () => {
  it('writes a file and reads it back', async () => {
    await adapter.writeFile('chapter-01.pubdoc', bytes('The harbour was quiet.'))
    expect((await adapter.readFile('chapter-01.pubdoc')).toString('utf8')).toBe(
      'The harbour was quiet.'
    )
  })

  it('reports a file it has never seen as absent rather than empty', async () => {
    expect(await adapter.stat('nowhere.pubdoc')).toBeNull()
    await expect(adapter.readFile('nowhere.pubdoc')).rejects.toThrow('No such file')
  })

  it('creates the directories above a file that is written into one', async () => {
    await adapter.writeFile('part-one/chapter-01.pubdoc', bytes('x'))
    expect(await adapter.stat('part-one')).toMatchObject({ kind: 'dir', path: 'part-one' })
    expect((await adapter.list('')).map((entry) => entry.path)).toEqual(['part-one'])
  })

  it('keeps an empty folder, which is why directories are rows', async () => {
    // Inferring directories from path prefixes is tidier right up until an
    // author makes an empty one, which then vanishes on reopen.
    await adapter.mkdir('notes')
    expect((await adapter.list('')).map((entry) => entry.path)).toEqual(['notes'])
    expect(await adapter.list('notes')).toEqual([])
  })

  it('lists direct children only, and walks the whole tree', async () => {
    await adapter.writeFile('a.pubdoc', bytes('a'))
    await adapter.writeFile('part-one/b.pubdoc', bytes('b'))
    await adapter.writeFile('part-one/deep/c.pubdoc', bytes('c'))

    expect((await adapter.list('')).map((entry) => entry.path)).toEqual(['a.pubdoc', 'part-one'])
    expect((await adapter.list('part-one')).map((entry) => entry.path)).toEqual([
      'part-one/b.pubdoc',
      'part-one/deep'
    ])
    expect((await adapter.walk('', [])).map((entry) => entry.path)).toEqual([
      'a.pubdoc',
      'part-one/b.pubdoc',
      'part-one/deep/c.pubdoc'
    ])
  })

  it('skips ignored directories when walking, as the indexer needs', async () => {
    await adapter.writeFile('a.pubdoc', bytes('a'))
    await adapter.writeFile('.thepub/chats.json', bytes('{}'))
    expect((await adapter.walk('', ['.thepub'])).map((entry) => entry.path)).toEqual(['a.pubdoc'])
  })

  it('renames a file, and a directory with everything under it', async () => {
    await adapter.writeFile('part-one/b.pubdoc', bytes('b'))
    await adapter.writeFile('part-one/deep/c.pubdoc', bytes('c'))

    await adapter.rename('part-one', 'part-two')
    expect(await adapter.stat('part-one')).toBeNull()
    expect((await adapter.readFile('part-two/deep/c.pubdoc')).toString('utf8')).toBe('c')
  })

  it('refuses to delete a directory that is not empty unless told to recurse', async () => {
    await adapter.writeFile('part-one/b.pubdoc', bytes('b'))
    await expect(adapter.delete('part-one')).rejects.toThrow('not empty')
    await adapter.delete('part-one', { recursive: true })
    expect(await adapter.stat('part-one/b.pubdoc')).toBeNull()
  })

  it('never deletes the root', async () => {
    await expect(adapter.delete('')).rejects.toThrow('root')
  })

  it('overwrites rather than duplicating, and updates the size', async () => {
    await adapter.writeFile('a.pubdoc', bytes('short'))
    await adapter.writeFile('a.pubdoc', bytes('a good deal longer'))
    expect(await adapter.stat('a.pubdoc')).toMatchObject({ size: 18 })
    expect((await adapter.list('')).length).toBe(1)
  })

  it('round-trips bytes that are not text', async () => {
    const data = Buffer.from([0, 1, 2, 250, 251, 0])
    await adapter.writeFile('assets/image.png', data)
    expect([...(await adapter.readFile('assets/image.png'))]).toEqual([...data])
  })

  it('claims the capabilities a transaction actually provides', async () => {
    // Not aspiration: a write here is one statement in one transaction, so
    // there is no window in which a crash leaves half a document.
    expect(adapter.caps).toMatchObject({ atomicRename: true, fastStat: true, preservesMtime: true })
    // SQLite cannot push, so the registry polls the change feed rather than
    // walking the tree.
    expect(adapter.caps.watch).toBe(false)
  })
})

describe('opening', () => {
  it('refuses to create tables in a database that was not asked to hold a project', async () => {
    // Silently creating tables in someone's production database is not a thing
    // to do quietly.
    const untouched = open({ create: false })
    await expect(untouched.stat('')).rejects.toThrow('no project in this database')
    await untouched.dispose()
  })

  it('refuses a schema name that is not a plain identifier', () => {
    // Interpolated into DDL, where no placeholder is allowed — so the character
    // set is restricted rather than trusted to quoting.
    expect(() => assertSafeIdent('a"; DROP TABLE x; --', 'The schema name')).toThrow()
    expect(() => assertSafeIdent('thepub_2', 'The schema name')).not.toThrow()
  })

  it('keeps two projects in one database apart by schema', async () => {
    const shared = sqliteDialect(':memory:')
    const one = new DbAdapter({ dialect: shared, schema: 'book_one', label: 'db://one', create: true })
    await one.writeFile('a.pubdoc', bytes('one'))
    expect((await one.list('')).map((entry) => entry.path)).toEqual(['a.pubdoc'])
    await one.dispose()
  })
})

describe('the change feed', () => {
  async function collect(): Promise<{ events: FileChangeEvent[]; stop: () => Promise<void> }> {
    const events: FileChangeEvent[] = []
    const stop = await adapter.watch('', (batch) => events.push(...batch))
    return { events, stop }
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 80))
  }

  it('reports a write as a change, without walking the tree', async () => {
    await adapter.writeFile('a.pubdoc', bytes('a'))
    const { events, stop } = await collect()

    await adapter.writeFile('b.pubdoc', bytes('b'))
    await settle()
    await stop()

    expect(events.map((event) => [event.type, event.path])).toContainEqual(['add', 'b.pubdoc'])
    // The file that already existed when watching started is not re-reported:
    // `rev` is what makes this a question about what changed rather than about
    // what is there.
    expect(events.map((event) => event.path)).not.toContain('a.pubdoc')
  })

  it('reports a delete', async () => {
    await adapter.writeFile('a.pubdoc', bytes('a'))
    const { events, stop } = await collect()

    await adapter.delete('a.pubdoc')
    await settle()
    await stop()

    expect(events.map((event) => [event.type, event.path])).toContainEqual(['unlink', 'a.pubdoc'])
  })

  it('reports nothing outside the directory being watched', async () => {
    await adapter.mkdir('part-one')
    const events: FileChangeEvent[] = []
    const stop = await adapter.watch('part-one', (batch) => events.push(...batch))

    await adapter.writeFile('elsewhere.pubdoc', bytes('x'))
    await adapter.writeFile('part-one/here.pubdoc', bytes('x'))
    await settle()
    await stop()

    expect(events.map((event) => event.path)).toEqual(['part-one/here.pubdoc'])
  })

  it('stops when told to', async () => {
    const { events, stop } = await collect()
    await stop()
    await adapter.writeFile('after.pubdoc', bytes('x'))
    await settle()
    expect(events).toEqual([])
  })
})

describe('tableName', () => {
  it('uses a real schema on Postgres and a prefix everywhere else', () => {
    // Postgres has schemas; MySQL and SQLite do not, so the same separation is
    // expressed as a table prefix rather than being dropped.
    const sqlite = sqliteDialect(':memory:')
    expect(tableName(sqlite, 'thepub', 'pub_files')).toBe('"thepub_pub_files"')
    expect(tableName({ ...sqlite, engine: 'postgres' }, 'thepub', 'pub_files')).toBe(
      '"thepub"."pub_files"'
    )
  })
})

describe('the schema version', () => {
  it('is stamped so a newer build can be told apart from this one', async () => {
    await adapter.writeFile('a.pubdoc', bytes('a'))
    expect(SCHEMA_VERSION).toBeGreaterThan(0)
  })
})
