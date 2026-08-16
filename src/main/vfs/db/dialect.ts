import type { DbEngine } from '../../../shared/model/connection.js'

/**
 * The seam between "a project in a database" and "which database".
 *
 * Everything above this — the table layout, the queries, the adapter — is
 * written once. What differs between Postgres, MySQL and SQLite is small and
 * entirely mechanical: how an identifier is quoted, how a parameter is spelled,
 * what a blob column is called, and whether the server can push a change
 * notification. Keeping that list this short is the point; a dialect that
 * needed to rewrite queries would mean the abstraction was in the wrong place.
 *
 * No Electron import anywhere below this, following `src/main/onedrive/`, so
 * the whole of it tests as ordinary logic.
 */

export type DbValue = string | number | Uint8Array | null

export interface DbRow {
  [column: string]: DbValue | bigint | boolean | undefined
}

export interface DbConnection {
  all(sql: string, params?: readonly DbValue[]): Promise<DbRow[]>
  run(sql: string, params?: readonly DbValue[]): Promise<void>
  /**
   * Run `body` inside a transaction, rolling back if it throws.
   *
   * This is what makes `writeFileAtomic` genuinely atomic rather than the
   * temp-file-and-rename dance every other remote backend has to perform.
   */
  transaction<T>(body: () => Promise<T>): Promise<T>
  /** Server-pushed change notification, where the engine has one. */
  listen?(onChange: () => void): Promise<() => Promise<void>>
  close(): Promise<void>
}

export interface DbDialect {
  readonly engine: DbEngine
  quoteIdent(name: string): string
  /** Parameter marker for the `index`-th value, counting from 1. */
  placeholder(index: number): string
  /** The column type a file's bytes live in. */
  readonly blobType: string
  /** The column type a path lives in — MySQL cannot index an unbounded TEXT. */
  readonly pathType: string
  connect(): Promise<DbConnection>
}

/**
 * Refuse a name that is not a plain identifier.
 *
 * Schema names reach us from a saved profile, which a person typed, and they
 * are interpolated into DDL where no placeholder is allowed. Quoting alone is
 * not enough — a quote character inside the name escapes the quoting — so the
 * character set is restricted instead, which costs nothing real: no writer
 * needs a schema called `a"; drop table`.
 */
export function assertSafeIdent(name: string, what: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${what} must be letters, digits and underscores, starting with a letter.`)
  }
  return name
}

/** SQLite and MySQL have no schemas, so the schema name prefixes the tables instead. */
export function tableName(dialect: DbDialect, schema: string, table: string): string {
  const safe = assertSafeIdent(schema, 'The schema name')
  if (dialect.engine === 'postgres') {
    return `${dialect.quoteIdent(safe)}.${dialect.quoteIdent(table)}`
  }
  return dialect.quoteIdent(`${safe}_${table}`)
}
