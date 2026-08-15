import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Electron instances contend for the same user-data directory and display.
  fullyParallel: false,
  workers: 1,
  // The packaged suite needs an artifact from `npm run package`, which is not
  // there by default. It runs from playwright.packaged.config.ts instead.
  testIgnore: '**/packaged.spec.ts',
  reporter: [['list']]
})
