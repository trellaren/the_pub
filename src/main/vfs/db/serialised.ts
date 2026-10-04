import { AsyncLocalStorage } from 'node:async_hooks'
import type { DbConnection, DbRow, DbValue } from './dialect.js'

/** What a driver offers before transactions are made safe to share. */
export interface RawDbConnection {
  all(sql: string, params?: readonly DbValue[]): Promise<DbRow[]>
  run(sql: string, params?: readonly DbValue[]): Promise<void>
  begin(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  listen?(onChange: () => void): Promise<() => Promise<void>>
  close(): Promise<void>
}

/**
 * One connection, shared by every caller, with transactions that cannot bleed
 * into each other.
 *
 * A transaction belongs to the connection, not to the caller that began it, so
 * without this a second caller's statements land inside the first caller's
 * transaction, and a nested `transaction()` (a `put` inside `writeFile`) sends
 * its own BEGIN/COMMIT and ends the outer one early. Every statement therefore
 * queues behind any open transaction, and only work that is genuinely running
 * inside that transaction — tracked through the async context rather than a
 * shared counter, which another caller would also see — joins it instead.
 */
export function serialiseConnection(raw: RawDbConnection): DbConnection {
  const context = new AsyncLocalStorage<{ open: boolean }>()
  let tail: Promise<unknown> = Promise.resolve()

  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work)
    tail = result.catch(() => {})
    return result
  }

  // A callback scheduled inside a transaction keeps its async context after
  // the COMMIT, so "inside" means the transaction is still open, not merely
  // that the context says one was.
  const joined = (): boolean => context.getStore()?.open === true

  const statement =
    <T>(call: (sql: string, params?: readonly DbValue[]) => Promise<T>) =>
    (sql: string, params?: readonly DbValue[]): Promise<T> =>
      joined() ? call(sql, params) : exclusive(() => call(sql, params))

  return {
    all: statement((sql, params) => raw.all(sql, params)),
    run: statement((sql, params) => raw.run(sql, params)),
    transaction: <T>(body: () => Promise<T>): Promise<T> => {
      if (joined()) return body()
      return exclusive(() => {
        const state = { open: true }
        return context.run(state, async () => {
          await raw.begin()
          try {
            const result = await body()
            await raw.commit()
            return result
          } catch (error) {
            await raw.rollback().catch(() => {})
            throw error
          } finally {
            state.open = false
          }
        })
      })
    },
    ...(raw.listen ? { listen: raw.listen.bind(raw) } : {}),
    close: () => raw.close()
  }
}
