import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => userData.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^enc:/, '')
  }
}))

const { ConnectionStore } = await import('./connectionStore.js')

const base = { name: 'Server', protocol: 'sftp' as const, host: 'a.example', port: 22, user: 'me' }

describe('ConnectionStore.save', () => {
  beforeEach(() => {
    userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quoth-conn-'))
  })
  afterEach(() => {
    fs.rmSync(userData.dir, { recursive: true, force: true })
  })

  it('keeps the secret when an edit leaves the destination alone', () => {
    const store = new ConnectionStore()
    const saved = store.save(base, 'hunter2')
    const renamed = store.save({ ...saved, name: 'Renamed', remotePath: '/books' })
    expect(renamed.hasSecret).toBe(true)
    expect(store.secret(saved.id)).toBe('hunter2')
  })

  it.each([
    ['host', { host: 'evil.example' }],
    ['port', { port: 2222 }],
    ['user', { user: 'root' }],
    ['protocol', { protocol: 'ftp' as const }],
    ['auth', { auth: 'key' as const }],
    ['engine', { engine: 'mysql' as const }]
  ])('drops the secret when %s changes without a new one', (_field, change) => {
    const store = new ConnectionStore()
    const saved = store.save(base, 'hunter2')
    const edited = store.save({ ...saved, ...change })
    expect(edited.hasSecret).toBe(false)
    expect(store.secret(saved.id)).toBeNull()
  })

  it('stores the new secret when one is supplied with the change', () => {
    const store = new ConnectionStore()
    const saved = store.save(base, 'hunter2')
    const edited = store.save({ ...saved, host: 'b.example' }, 'fresh')
    expect(edited.hasSecret).toBe(true)
    expect(store.secret(saved.id)).toBe('fresh')
  })
})
