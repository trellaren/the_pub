import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
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

/**
 * The accelerator the *native* menu is currently showing for an item.
 *
 * Read from the real `Menu` in the main process rather than from app state,
 * because app state agreeing with itself proves nothing — the thing that can
 * break is the menu not being rebuilt after a rebinding.
 */
async function menuAccelerator(
  app: ElectronApplication,
  menuLabel: string,
  itemLabel: string
): Promise<string | undefined> {
  return app.evaluate(({ Menu }, labels) => {
    const menu = Menu.getApplicationMenu()
    const section = menu?.items.find((item) => item.label === labels.menuLabel)
    const entry = section?.submenu?.items.find((item) => item.label === labels.itemLabel)
    return entry?.accelerator
  }, { menuLabel, itemLabel })
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

test('a fresh install opens on Raven, and the picker groups the themes it offers', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  // Nothing has chosen a theme here: this is what a first run paints.
  await expect(harness.page.locator('html')).toHaveAttribute('data-theme', 'raven')
  await expect(harness.page.locator('html')).toHaveCSS('color-scheme', 'dark')

  await openSettings(harness.page)
  const groups = harness.page.getByLabel('Theme').locator('optgroup')
  await expect(groups).toHaveCount(5)
  await expect(groups.first()).toHaveAttribute('label', 'Raven')

  // The scheme follows the theme, not its id — a light theme has to reach
  // `color-scheme`, or its form controls and scrollbars stay dark.
  await harness.page.getByLabel('Theme').selectOption('high-contrast-light')
  await expect(harness.page.locator('html')).toHaveCSS('color-scheme', 'light')
})

test('the Keyboard shortcuts section lists menu commands with their defaults', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await openSettings(harness.page)

  await expect(harness.page.getByLabel('Shortcut for Save', { exact: true })).toHaveText('CmdOrCtrl+S')
  // A command the menu ships with no shortcut is still offered for binding.
  await expect(harness.page.getByLabel('Shortcut for New Folder', { exact: true })).toHaveText('Unassigned')
})

test('rebinding a command reaches the native menu and survives a restart', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await openSettings(harness.page)

  expect(await menuAccelerator(harness.app, 'File', 'Save')).toBe('CmdOrCtrl+S')

  const shortcut = harness.page.getByLabel('Shortcut for Save', { exact: true })
  await shortcut.click()
  await expect(shortcut).toHaveText('Press a combination…')
  await shortcut.press('Control+Alt+J')

  await expect(shortcut).toHaveText('CmdOrCtrl+Alt+J')
  await waitFor(
    async () => (await menuAccelerator(harness.app, 'File', 'Save')) === 'CmdOrCtrl+Alt+J',
    'the native menu to pick up the new accelerator'
  )

  // Relaunched against the same user-data directory: the binding lives beside
  // the theme, so it has to outlive the window that set it.
  await harness.app.close()
  const restarted = await launch({
    projectDir: harness.projectDir,
    userDataDir: harness.userDataDir
  })
  harness = restarted

  expect(await menuAccelerator(restarted.app, 'File', 'Save')).toBe('CmdOrCtrl+Alt+J')
  const state = await restarted.page.evaluate(() => window.pub.invoke('app:getState', {}))
  expect(state.keybindings['document.save']).toBe('CmdOrCtrl+Alt+J')
})

test('a combination another command already uses is refused, naming it', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await openSettings(harness.page)

  const shortcut = harness.page.getByLabel('Shortcut for Save', { exact: true })
  await shortcut.click()
  await shortcut.press('Control+o')

  await expect(harness.page.locator('text=Already used by Open Folder…')).toBeVisible()
  await expect(shortcut).toHaveText('CmdOrCtrl+S')
  expect(await menuAccelerator(harness.app, 'File', 'Save')).toBe('CmdOrCtrl+S')
})

test('resetting a shortcut puts the default back', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await openSettings(harness.page)

  const shortcut = harness.page.getByLabel('Shortcut for Save', { exact: true })
  await shortcut.click()
  await shortcut.press('Control+Alt+J')
  await expect(shortcut).toHaveText('CmdOrCtrl+Alt+J')

  await harness.page.getByLabel('Reset shortcut for Save', { exact: true }).click()

  await expect(shortcut).toHaveText('CmdOrCtrl+S')
  await waitFor(
    async () => (await menuAccelerator(harness.app, 'File', 'Save')) === 'CmdOrCtrl+S',
    'the native menu to go back to the default accelerator'
  )
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
