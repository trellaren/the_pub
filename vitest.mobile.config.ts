import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/*
 * Runs the desktop search index's own tests against the SQLite stand-in the iOS
 * build uses, alongside the tests for the iOS host itself. The stand-in exists
 * to behave like `node:sqlite`; the suite written against the real one is the
 * best statement of what that means.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/mobile/**/*.test.ts', 'src/main/services/searchIndexService.test.ts'],
    setupFiles: ['src/mobile/host/testRuntime.ts'],
    reporters: ['default']
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer'),
      'node:sqlite': resolve('src/mobile/host/shims/sqlite.ts')
    }
  }
})
