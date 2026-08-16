import { DatabaseSync } from 'node:sqlite'
import type { DbConnection, DbDialect, DbRow, DbValue } from './dialect.js'

/**
 * The three dialects.
 *
 * `pg` and `mysql2` are imported inside `connect()` rather than at the top of
 * the file, so a writer who only ever opens local folders never loads either —
 * and neither ever reaches a bundle the renderer can see.
 */

export interface DbTarget {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export function sqliteDialect(file: string): DbDialect {
  return {
    engine: 'sqlite',
    quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
    placeholder: () => '?',
    blobType: 'BLOB',
    pathType: 'TEXT',
    connect: async () => sqliteConnection(file)
  }
}

/**
 * SQLite through `node:sqlite`, which is synchronous.
 *
 * Wrapped in promises rather than made truly async: the calls do not block on a
 * network, and a worker thread to make them "properly" asynchronous would add a
 * failure mode to buy nothing. This is the same database the search index
 * already runs on.
 */
function sqliteConnection(file: string): DbConnection {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  // Without this a second window opening the same file fails immediately rather
  // than waiting for the first one's write to finish.
  db.exec('PRAGMA busy_timeout = 5000')
  let depth = 0

  return {
    all: async (sql, params = []) => db.prepare(sql).all(...(params as DbValue[])) as DbRow[],
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as DbValue[]))
    },
    transaction: async (body) => {
      // Nested calls join the outer transaction rather than starting one SQLite
      // would reject: `writeFileAtomic` inside a `rename` is an ordinary shape.
      if (depth > 0) return body()
      depth += 1
      db.exec('BEGIN')
      try {
        const result = await body()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        depth -= 1
      }
    },
    close: async () => {
      try {
        db.close()
      } catch {
        // Already closed.
      }
    }
  }
}

export function postgresDialect(target: DbTarget): DbDialect {
  return {
    engine: 'postgres',
    quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
    placeholder: (index) => `$${index}`,
    blobType: 'BYTEA',
    pathType: 'TEXT',
    connect: async () => {
      const { Client } = await import('pg')
      const client = new Client({
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password,
        database: target.database
      })
      await client.connect()

      return {
        all: async (sql, params = []) => (await client.query(sql, [...params])).rows as DbRow[],
        run: async (sql, params = []) => {
          await client.query(sql, [...params])
        },
        transaction: async (body) => {
          await client.query('BEGIN')
          try {
            const result = await body()
            await client.query('COMMIT')
            return result
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          }
        },
        listen: async (onChange) => {
          // The reason Postgres is the one engine with `watch: true`: a change
          // arrives when it happens rather than up to fifteen seconds later.
          const notified = (): void => onChange()
          client.on('notification', notified)
          await client.query('LISTEN pub_changed')
          return async () => {
            client.off('notification', notified)
            await client.query('UNLISTEN pub_changed').catch(() => {})
          }
        },
        close: async () => {
          await client.end().catch(() => {})
        }
      }
    }
  }
}

export function mysqlDialect(target: DbTarget): DbDialect {
  return {
    engine: 'mysql',
    quoteIdent: (name) => `\`${name.replace(/`/g, '``')}\``,
    placeholder: () => '?',
    blobType: 'LONGBLOB',
    // MySQL cannot index an unbounded TEXT, and `path` is the primary key.
    // 768 is the byte budget of an InnoDB index prefix at four bytes a
    // character; no project-relative path comes close.
    pathType: 'VARCHAR(768)',
    connect: async () => {
      const mysql = await import('mysql2/promise')
      const connection = await mysql.createConnection({
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password,
        database: target.database
      })

      return {
        all: async (sql, params = []) => {
          const [rows] = await connection.query(sql, [...params])
          return (Array.isArray(rows) ? rows : []) as DbRow[]
        },
        run: async (sql, params = []) => {
          await connection.query(sql, [...params])
        },
        transaction: async (body) => {
          await connection.beginTransaction()
          try {
            const result = await body()
            await connection.commit()
            return result
          } catch (error) {
            await connection.rollback()
            throw error
          }
        },
        close: async () => {
          await connection.end().catch(() => {})
        }
      }
    }
  }
}
