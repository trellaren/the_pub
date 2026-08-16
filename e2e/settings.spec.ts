import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs/promises'
import { launch, openProject, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { ProjectManifest } from '../src/shared/model/manifest.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

function manifestFile(): string {
  return path.join(harness.projectDir, '.thepub', 'project.json')
}

/** Open the panel and wait for it to actually be there before touching it. */
async function openSettings(page: Page): Promise<void> {
  await page.evaluate(() => window.__pub.runCommand('panel.settings'))
  await expect(page.getByLabel('Autosave delay (ms)')).toBeVisible()
}

test('the Settings panel opens through its command and shows the project and app sections', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await openSettings(harness.page)

  await expect(harness.page.locator('text=Settings').first()).toBeVisible()
  await expect(harness.page.getByLabel('Theme')).toBeVisible()
})

test('changing a project setting writes it to project.json', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await openSettings(harness.page)

  await harness.page.getByLabel('Autosave delay (ms)').fill('1500')

  await waitFor(async () => {
    const manifest = await readJson<ProjectManifest>(manifestFile())
    return manifest.settings.autosaveDebounceMs === 1500
  }, 'the manifest to record the new autosave delay')
})

test('toggling version history off is reflected in project.json', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await openSettings(harness.page)

  await harness.page.getByLabel('Keep version history').uncheck()

  await waitFor(async () => {
    const manifest = await readJson<ProjectManifest>(manifestFile())
    return manifest.settings.snapshotsEnabled === false
  }, 'the manifest to record snapshots being turned off')
})

test('changing the theme in Settings updates app state and applies immediately', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await openSettings(harness.page)

  await harness.page.getByLabel('Theme').selectOption('ocean')

  await expect(harness.page.locator('html')).toHaveAttribute('data-theme', 'ocean')

  const state = await harness.page.evaluate(() => window.pub.invoke('app:getState', {}))
  expect(state.theme).toBe('ocean')
})

test('a read-only project refuses to change settings and says why', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const before = await readJson<ProjectManifest>(manifestFile())

  // Bump the on-disk manifest's formatVersion and reopen — the same path
  // Phase 0's read-only guard is tested through.
  await fs.writeFile(
    manifestFile(),
    `${JSON.stringify({ ...before, formatVersion: 99 }, null, 2)}\n`,
    'utf8'
  )
  await harness.page.evaluate((uri) => window.__pub.project.getState().open(uri), harness.projectDir)
  await harness.page.waitForFunction(() => window.__pub.project.getState().project?.readOnly === true)
  await openSettings(harness.page)

  await expect(harness.page.locator('text=read-only').first()).toBeVisible()

  await harness.page.getByLabel('Autosave delay (ms)').fill('999')
  await harness.page.waitForTimeout(500)

  const after = await readJson<ProjectManifest>(manifestFile())
  expect(after.settings.autosaveDebounceMs).not.toBe(999)
})
