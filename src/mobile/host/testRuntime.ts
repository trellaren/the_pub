import { beforeAll } from 'vitest'
import { MobileFs, MemoryBlobStore } from './mobileFs.js'
import { installRuntime } from './runtime.js'
import { initSqlite } from './shims/sqlite.js'

beforeAll(async () => {
  const fs = await MobileFs.open(new MemoryBlobStore(), { persistent: [], eager: () => true })
  installRuntime({
    fs,
    init: { native: false, locale: 'en-GB', version: '0.0.0', redirectUri: 'http://localhost/auth.html' },
    post: () => {},
    storageKey: new Uint8Array(32)
  })
  await initSqlite()
})
