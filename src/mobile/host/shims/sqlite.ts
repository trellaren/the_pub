import sqlite3InitModule, { type Database, type PreparedStatement, type Sqlite3Static, type BindingSpec } from '@sqlite.org/sqlite-wasm'
import { current } from '../runtime.js'

/**
 * `node:sqlite`'s synchronous API over SQLite compiled to WebAssembly.
 *
 * The database runs in memory and is written back to the app's storage as one
 * file, a moment after it was last changed and again on close. Everything kept
 * in one is a cache that can be rebuilt, so a write lost to a sudden exit costs
 * a re-index and nothing else.
 */

let sqlite3: Sqlite3Static | null = null

export async function initSqlite(): Promise<void> {
  sqlite3 ??= await sqlite3InitModule()
}

function engine(): Sqlite3Static {
  if (!sqlite3) throw new Error('SQLite has not been loaded')
  return sqlite3
}

const SAVE_DELAY_MS = 3000

type Row = Record<string, unknown>

export class StatementSync {
  constructor(
    private readonly statement: PreparedStatement,
    private readonly touched: () => void
  ) {}

  run(...params: unknown[]): { changes: number } {
    this.execute(params, () => {
      while (this.statement.step()) {
        // Drain: a statement with RETURNING yields rows nobody asked for.
      }
    })
    this.touched()
    return { changes: 0 }
  }

  get(...params: unknown[]): Row | undefined {
    return this.execute(params, () => (this.statement.step() ? (this.statement.get({}) as Row) : undefined))
  }

  all(...params: unknown[]): Row[] {
    return this.execute(params, () => {
      const rows: Row[] = []
      while (this.statement.step()) rows.push(this.statement.get({}) as Row)
      return rows
    })
  }

  iterate(...params: unknown[]): IterableIterator<Row> {
    return this.all(...params)[Symbol.iterator]()
  }

  private execute<T>(params: unknown[], read: () => T): T {
    try {
      if (params.length > 0) this.statement.bind(params as BindingSpec)
      return read()
    } finally {
      this.statement.reset(true)
    }
  }
}

export class DatabaseSync {
  private db: Database
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(private readonly file: string) {
    const { oo1, capi, wasm } = engine()
    this.db = new oo1.DB(':memory:')
    const fs = current().fs
    if (!fs.existsSync(file)) return
    try {
      // A plain copy: the allocator recognises typed arrays by constructor, and a Buffer is not one of them.
      const bytes = new Uint8Array(fs.readFileSync(file) as Uint8Array)
      const pointer = wasm.allocFromTypedArray(bytes)
      const result = capi.sqlite3_deserialize(
        this.db.pointer!,
        'main',
        pointer,
        bytes.byteLength,
        bytes.byteLength,
        capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE
      )
      this.db.checkRc(result)
      this.db.exec('SELECT count(*) FROM sqlite_master')
    } catch {
      // Unreadable, so start empty: the caller rebuilds what it finds missing.
      this.db.close()
      this.db = new oo1.DB(':memory:')
    }
  }

  exec(sql: string): void {
    this.db.exec(sql)
    this.touch()
  }

  prepare(sql: string): StatementSync {
    return new StatementSync(this.db.prepare(sql), () => this.touch())
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.dirty) this.save()
    this.db.close()
  }

  private touch(): void {
    this.dirty = true
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.save()
    }, SAVE_DELAY_MS)
  }

  private save(): void {
    // Mid-transaction the image would hold half a batch; the commit touches again.
    if (!engine().capi.sqlite3_get_autocommit(this.db.pointer!)) {
      this.touch()
      return
    }
    this.dirty = false
    try {
      const fs = current().fs
      fs.mkdirSync(this.file.slice(0, this.file.lastIndexOf('/')) || '/', { recursive: true })
      fs.writeFileSync(this.file, engine().capi.sqlite3_js_db_export(this.db.pointer!))
    } catch {
      // The index is a cache; failing to keep it must not fail the write that changed it.
    }
  }
}
