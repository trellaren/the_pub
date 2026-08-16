import { assertSafeIdent, tableName, type DbConnection, type DbDialect, type DbValue } from './dialect.js'

/**
 * A project's files, as rows.
 *
 * Three tables and one counter. The shape is deliberately unclever — there is
 * no tree, no inode, no content addressing — because the thing above it is a
 * POSIX-path filesystem interface, and any structure richer than "path is the
 * key" would have to be flattened back into that on every call.
 *
 * `SCHEMA_VERSION` is stamped in `pub_meta` and guarded the same way every file
 * kind is: a database written by a newer build opens read-only rather than
 * being "upgraded" by a build that does not know what it is looking at.
 */
export const SCHEMA_VERSION = 1

/**
 * How many change rows to keep.
 *
 * A watcher that has fallen further behind than this re-syncs from scratch,
 * which is exactly what the polling watcher does on its first tick anyway — so
 * the window is a performance choice, not a correctness one.
 */
export const CHANGE_WINDOW = 5000

export interface DbFileRow {
  path: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  rev: number
}

export interface DbChangeRow {
  rev: number
  path: string
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
}

export class DbStore {
  private readonly files: string
  private readonly changes: string
  private readonly meta: string

  constructor(
    private readonly dialect: DbDialect,
    private readonly connection: DbConnection,
    private readonly schema: string
  ) {
    assertSafeIdent(schema, 'The schema name')
    this.files = tableName(dialect, schema, 'pub_files')
    this.changes = tableName(dialect, schema, 'pub_changes')
    this.meta = tableName(dialect, schema, 'pub_meta')
  }

  /**
   * Run several operations as one.
   *
   * Exposed so a rename, which is a read and many writes, either happens whole
   * or not at all — the guarantee that makes a database worth being a backend.
   */
  transaction<T>(body: () => Promise<T>): Promise<T> {
    return this.connection.transaction(body)
  }

  /** Placeholders for a statement, numbered the way this dialect wants. */
  private marks(count: number): string[] {
    return Array.from({ length: count }, (_, offset) => this.dialect.placeholder(offset + 1))
  }

  /**
   * Whether this database already holds a project, and whether this build may
   * write to it.
   *
   * Asked before anything is created, because creating tables in someone's
   * production database is not a thing to do quietly — the dialog turns
   * `exists: false` into an explicit sentence and a button.
   */
  async inspect(): Promise<{ exists: boolean; tooNew: boolean; version: number }> {
    try {
      const rows = await this.connection.all(
        `SELECT value FROM ${this.meta} WHERE ${this.dialect.quoteIdent('key')} = ${this.dialect.placeholder(1)}`,
        ['schemaVersion']
      )
      const raw = rows[0]?.value
      if (raw === undefined || raw === null) return { exists: false, tooNew: false, version: 0 }
      const version = Number(raw)
      return { exists: true, tooNew: version > SCHEMA_VERSION, version }
    } catch {
      // The tables are not there. Any other failure — a bad password, an
      // unreachable host — has already thrown from `connect`.
      return { exists: false, tooNew: false, version: 0 }
    }
  }

  async create(): Promise<void> {
    const { blobType, pathType } = this.dialect
    if (this.dialect.engine === 'postgres') {
      await this.connection.run(`CREATE SCHEMA IF NOT EXISTS ${this.dialect.quoteIdent(this.schema)}`)
    }

    await this.connection.run(
      `CREATE TABLE IF NOT EXISTS ${this.meta} (
         ${this.dialect.quoteIdent('key')} VARCHAR(64) PRIMARY KEY,
         value TEXT NOT NULL
       )`
    )
    await this.connection.run(
      `CREATE TABLE IF NOT EXISTS ${this.files} (
         path    ${pathType} PRIMARY KEY,
         kind    VARCHAR(8) NOT NULL,
         content ${blobType},
         size    BIGINT NOT NULL,
         mtime   BIGINT NOT NULL,
         rev     BIGINT NOT NULL
       )`
    )
    await this.connection.run(
      `CREATE TABLE IF NOT EXISTS ${this.changes} (
         rev  BIGINT PRIMARY KEY,
         path ${pathType} NOT NULL,
         type VARCHAR(16) NOT NULL,
         at   BIGINT NOT NULL
       )`
    )

    // Only when the tables were genuinely empty, so re-opening a project does
    // not rewrite its creation date or, worse, stamp this build's schema
    // version over one it did not write.
    if (!(await this.inspect()).exists) {
      const [key, value] = this.marks(2)
      const insertMeta = `INSERT INTO ${this.meta} (${this.dialect.quoteIdent('key')}, value) VALUES (${key}, ${value})`
      await this.connection.run(insertMeta, ['schemaVersion', String(SCHEMA_VERSION)])
      await this.connection.run(insertMeta, ['created', new Date().toISOString()])
    }

    // The root always exists, the way a mounted filesystem's root does. Making
    // it a row rather than a special case is what keeps `list('')` an ordinary
    // prefix query.
    await this.put({ path: '', kind: 'dir', content: null })
  }

  async get(path: string): Promise<DbFileRow | null> {
    const rows = await this.connection.all(
      `SELECT path, kind, size, mtime, rev FROM ${this.files} WHERE path = ${this.dialect.placeholder(1)}`,
      [path]
    )
    return rows[0] ? toFileRow(rows[0]) : null
  }

  async read(path: string): Promise<Uint8Array | null> {
    const rows = await this.connection.all(
      `SELECT content FROM ${this.files} WHERE path = ${this.dialect.placeholder(1)} AND kind = ${this.dialect.placeholder(2)}`,
      [path, 'file']
    )
    const content = rows[0]?.content
    if (content === undefined || content === null) return null
    return toBytes(content)
  }

  /**
   * Every descendant of `dir`, or its direct children.
   *
   * One prefix query either way. The root is excluded by construction: its path
   * is the empty string, which is a prefix of everything.
   */
  async children(dir: string, recursive: boolean): Promise<DbFileRow[]> {
    const prefix = dir === '' ? '' : `${dir}/`
    // A range rather than a LIKE: the primary key on `path` answers it as an
    // index scan in every engine, and there is no escaping to get wrong. The
    // upper bound is the prefix with its last character bumped, which is the
    // first path that cannot be inside this directory.
    const marks = this.marks(2)
    const rows =
      prefix === ''
        ? await this.connection.all(
            `SELECT path, kind, size, mtime, rev FROM ${this.files} WHERE path <> ${this.marks(1)[0]}`,
            ['']
          )
        : await this.connection.all(
            `SELECT path, kind, size, mtime, rev FROM ${this.files}
             WHERE path >= ${marks[0]} AND path < ${marks[1]}`,
            [prefix, upperBound(prefix)]
          )

    return rows
      .map(toFileRow)
      .filter((row) => {
        if (row.path === '' || !row.path.startsWith(prefix)) return false
        const rest = row.path.slice(prefix.length)
        if (rest === '') return false
        return recursive || !rest.includes('/')
      })
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  /**
   * Write one row and record the change.
   *
   * `rev` comes from the change log rather than a sequence object, because a
   * sequence is three different things in three dialects and this is one
   * indexed `MAX` on a table that is pruned to a bounded size.
   */
  async put(entry: {
    path: string
    kind: 'file' | 'dir'
    content: Uint8Array | null
    mtime?: number
  }): Promise<number> {
    return this.connection.transaction(async () => {
      const existing = await this.get(entry.path)
      const rev = await this.nextRev()
      const mtime = entry.mtime ?? Date.now()
      const size = entry.content?.byteLength ?? 0

      const marks = this.marks(6)
      if (existing) {
        // Its own parameter order, not the insert's reordered. A dialect whose
        // placeholder is a bare `?` binds by position *in the SQL*, so reusing
        // the insert's list here would shift every value by one — and would do
        // it only on SQLite and MySQL, passing cleanly against Postgres, whose
        // `$n` says which value it means.
        await this.connection.run(
          `UPDATE ${this.files} SET kind = ${marks[0]}, content = ${marks[1]}, size = ${marks[2]},
             mtime = ${marks[3]}, rev = ${marks[4]} WHERE path = ${marks[5]}`,
          [entry.kind, entry.content ?? null, size, mtime, rev, entry.path]
        )
      } else {
        await this.connection.run(
          `INSERT INTO ${this.files} (path, kind, content, size, mtime, rev)
           VALUES (${marks.join(', ')})`,
          [entry.path, entry.kind, entry.content ?? null, size, mtime, rev] satisfies DbValue[]
        )
      }

      const type = existing
        ? entry.kind === 'dir'
          ? 'addDir'
          : 'change'
        : entry.kind === 'dir'
          ? 'addDir'
          : 'add'
      // The root is written on create and is not a change anyone watches for.
      if (entry.path !== '') await this.recordChange(rev, entry.path, type)
      return rev
    })
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    await this.connection.transaction(async () => {
      const target = await this.get(path)
      if (!target) return
      const doomed = recursive ? [target, ...(await this.children(path, true))] : [target]
      for (const row of doomed) {
        await this.connection.run(
          `DELETE FROM ${this.files} WHERE path = ${this.dialect.placeholder(1)}`,
          [row.path]
        )
        await this.recordChange(await this.nextRev(), row.path, row.kind === 'dir' ? 'unlinkDir' : 'unlink')
      }
    })
  }

  /** The current revision, which a watcher resumes from. */
  async head(): Promise<number> {
    const rows = await this.connection.all(`SELECT MAX(rev) AS head FROM ${this.changes}`)
    return Number(rows[0]?.head ?? 0)
  }

  /**
   * Changes after `since`, and whether the caller has fallen out of the window.
   *
   * `stale` is not an error: it means "re-read everything", which is what a
   * first connection does anyway. Reporting it rather than silently returning
   * a short list is what stops a watcher missing an edit it can never learn
   * about.
   */
  async changesSince(since: number): Promise<{ changes: DbChangeRow[]; head: number; stale: boolean }> {
    const head = await this.head()
    const oldest = await this.connection.all(`SELECT MIN(rev) AS oldest FROM ${this.changes}`)
    const first = Number(oldest[0]?.oldest ?? 0)
    if (since > 0 && first > since + 1) {
      return { changes: [], head, stale: true }
    }
    const rows = await this.connection.all(
      `SELECT rev, path, type FROM ${this.changes} WHERE rev > ${this.dialect.placeholder(1)} ORDER BY rev`,
      [since]
    )
    return {
      changes: rows.map((row) => ({
        rev: Number(row.rev),
        path: String(row.path),
        type: String(row.type) as DbChangeRow['type']
      })),
      head,
      stale: false
    }
  }

  private async nextRev(): Promise<number> {
    return (await this.head()) + 1
  }

  private async recordChange(rev: number, path: string, type: DbChangeRow['type']): Promise<void> {
    const marks = this.marks(4)
    await this.connection.run(
      `INSERT INTO ${this.changes} (rev, path, type, at) VALUES (${marks.join(', ')})`,
      [rev, path, type, Date.now()]
    )
    if (rev % 256 === 0) await this.prune(rev)
  }

  /** Keep the change log bounded. See `CHANGE_WINDOW`. */
  private async prune(head: number): Promise<void> {
    await this.connection.run(
      `DELETE FROM ${this.changes} WHERE rev <= ${this.dialect.placeholder(1)}`,
      [head - CHANGE_WINDOW]
    )
  }
}

/** The first string that sorts after every path beginning with `prefix`. */
function upperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1)
  return prefix.slice(0, -1) + String.fromCharCode(last + 1)
}

function toFileRow(row: Record<string, unknown>): DbFileRow {
  return {
    path: String(row.path),
    kind: String(row.kind) === 'dir' ? 'dir' : 'file',
    size: Number(row.size ?? 0),
    mtime: Number(row.mtime ?? 0),
    rev: Number(row.rev ?? 0)
  }
}

/** Each driver hands back bytes in its own wrapper; none of them is a Buffer to us. */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value && typeof value === 'object' && 'data' in (value as { data?: unknown })) {
    return new Uint8Array((value as { data: number[] }).data)
  }
  return new Uint8Array(0)
}
