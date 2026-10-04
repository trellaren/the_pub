import { describe, it, expect } from 'vitest'
import { serialiseConnection, type RawDbConnection } from './serialised.js'
import { sqliteDialect } from './dialects.js'

function fakeClient(): { raw: RawDbConnection; log: string[] } {
  const log: string[] = []
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1))
  const raw: RawDbConnection = {
    all: async (sql) => {
      await tick()
      log.push(sql)
      return []
    },
    run: async (sql) => {
      await tick()
      log.push(sql)
    },
    begin: async () => {
      await tick()
      log.push('BEGIN')
    },
    commit: async () => {
      await tick()
      log.push('COMMIT')
    },
    rollback: async () => {
      await tick()
      log.push('ROLLBACK')
    },
    close: async () => {}
  }
  return { raw, log }
}

describe('serialiseConnection', () => {
  it('lets a nested transaction join the outer one instead of committing it early', async () => {
    const { raw, log } = fakeClient()
    const connection = serialiseConnection(raw)
    await connection.transaction(async () => {
      await connection.run('outer')
      await connection.transaction(() => connection.run('inner'))
      await connection.run('after')
    })
    expect(log).toEqual(['BEGIN', 'outer', 'inner', 'after', 'COMMIT'])
  })

  it('runs concurrent transactions one after the other', async () => {
    const { raw, log } = fakeClient()
    const connection = serialiseConnection(raw)
    await Promise.all([
      connection.transaction(async () => {
        await connection.run('a1')
        await connection.run('a2')
      }),
      connection.transaction(async () => {
        await connection.run('b1')
        await connection.run('b2')
      })
    ])
    expect(log).toEqual(['BEGIN', 'a1', 'a2', 'COMMIT', 'BEGIN', 'b1', 'b2', 'COMMIT'])
  })

  it('holds another caller’s plain statement until the open transaction ends', async () => {
    const { raw, log } = fakeClient()
    const connection = serialiseConnection(raw)
    await Promise.all([
      connection.transaction(async () => {
        await connection.run('t1')
        await connection.run('t2')
      }),
      connection.all('outsider')
    ])
    expect(log).toEqual(['BEGIN', 't1', 't2', 'COMMIT', 'outsider'])
  })

  it('rolls back on failure and keeps serving the next caller', async () => {
    const { raw, log } = fakeClient()
    const connection = serialiseConnection(raw)
    const failed = connection.transaction(async () => {
      await connection.run('doomed')
      throw new Error('boom')
    })
    const next = connection.transaction(() => connection.run('next'))
    await expect(failed).rejects.toThrow('boom')
    await next
    expect(log).toEqual(['BEGIN', 'doomed', 'ROLLBACK', 'BEGIN', 'next', 'COMMIT'])
  })

  it('does not let work scheduled inside a committed transaction skip the queue', async () => {
    const { raw, log } = fakeClient()
    const connection = serialiseConnection(raw)
    let late: Promise<void> = Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    await connection.transaction(async () => {
      late = gate.then(() => connection.run('late'))
    })
    const holder = connection.transaction(async () => {
      await connection.run('h1')
      release()
      await new Promise((resolve) => setTimeout(resolve, 5))
      await connection.run('h2')
    })
    await Promise.all([holder, late])
    expect(log).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'h1', 'h2', 'COMMIT', 'late'])
  })
})

describe('the SQLite connection', () => {
  it('keeps a concurrent caller’s write out of a transaction that rolls back', async () => {
    const connection = await sqliteDialect(':memory:').connect()
    await connection.run('CREATE TABLE t (v TEXT)')
    const failing = connection.transaction(async () => {
      await connection.run('INSERT INTO t VALUES (?)', ['rolled back'])
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new Error('boom')
    })
    const other = connection.transaction(() => connection.run('INSERT INTO t VALUES (?)', ['kept']))
    await expect(failing).rejects.toThrow('boom')
    await other
    expect(await connection.all('SELECT v FROM t')).toEqual([{ v: 'kept' }])
    await connection.close()
  })
})
