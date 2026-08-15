import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

/**
 * The packaged suite: the same app, launched from the artifact
 * `electron-builder --dir` produces rather than from `out/`.
 *
 * It is a second config rather than a Playwright project because the everyday
 * command is `npx playwright test`, and a project split would quietly make that
 * do the wrong thing.
 */
export default defineConfig({
  ...base,
  // The base config hides this spec from the default run. Playwright applies
  // `testIgnore` and `testMatch` as *both* filters, so spreading it without
  // clearing it here would match nothing and report zero tests as a pass.
  testIgnore: undefined,
  testMatch: '**/packaged.spec.ts',
  // A packaged binary is slower off the mark than `electron .`.
  timeout: 120_000
})
