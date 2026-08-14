import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Electron instances contend for the same user-data directory and display.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']]
})
