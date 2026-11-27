import { defineConfig } from '@playwright/test'

const PORT = 4610

/*
 * The desktop suite drives Electron and so never needed a browser download.
 * This one does: `npx playwright install chromium` once, or name a Chromium
 * that is already on the machine.
 */
const chromium = process.env.QUOTH_E2E_CHROMIUM

/*
 * The iOS build, driven in a browser.
 *
 * It is the same bundle Capacitor wraps — the renderer, with the desktop main
 * process's services running in a worker beside it — so everything short of
 * the native shell itself is exercised here, on a machine with no Xcode.
 * Needs `npm run build:mobile` first, the way `npm run e2e` needs `npm run build`.
 */
export default defineConfig({
  testDir: './e2e/mobile',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    baseURL: `http://localhost:${PORT}`,
    // An 11-inch iPad, landscape.
    viewport: { width: 1194, height: 834 },
    hasTouch: true,
    ...(chromium ? { launchOptions: { executablePath: chromium } } : {})
  },
  webServer: {
    command: `npx vite preview -c vite.mobile.config.ts --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI
  }
})
