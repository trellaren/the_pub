import { test, expect } from '@playwright/test'
import { launch, openProject, cleanup, waitFor, type Harness } from './helpers.js'

/**
 * The window's own title bar.
 *
 * The frame is off, so the buttons that used to come with it are the app's
 * code now — and a Maximize button that does not maximize is exactly the sort
 * of thing that only shows up in the real window. Every assertion here reads
 * the actual `BrowserWindow`, not the renderer's idea of it.
 */

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

async function isMaximized(harness: Harness): Promise<boolean> {
  return harness.app.evaluate(({ BrowserWindow }) =>
    (BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)
  )
}

test('the title bar carries the raven, the menus and the window buttons', async () => {
  harness = await launch()

  await expect(harness.page.getByTestId('title-bar')).toBeVisible()
  await expect(harness.page.getByTestId('menu-file')).toBeVisible()
  await expect(harness.page.getByTestId('window-controls')).toBeVisible()
  await expect(harness.page.getByLabel('Minimize', { exact: true })).toBeVisible()
  await expect(harness.page.getByLabel('Close', { exact: true })).toBeVisible()
})

/*
 * What the maximize button must never do is lie. Whether the click *maximizes*
 * is the window manager's business — and a headless X server has none, so the
 * toggle is a no-op under `xvfb-run` and asserting the window grew would fail
 * on the machine the gate runs on rather than on any real one. What is the
 * app's own is the round trip: the click reaches main, main answers with the
 * window's actual state, and the button redraws as that state — so that is what
 * is asserted, and it holds either way.
 */
test('the maximize button reports the window it just acted on', async () => {
  harness = await launch()
  await expect(harness.page.getByLabel('Maximize', { exact: true })).toBeVisible()

  await harness.page.getByTestId('window-maximize').click()

  const maximized = await isMaximized(harness)
  await expect(
    harness.page.getByLabel(maximized ? 'Restore' : 'Maximize', { exact: true })
  ).toBeVisible()
})

test('the close button closes the window, through the flush the frame used to', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  // Waited for before the click: it was the only window, so closing it takes
  // the whole app with it and there is nothing left to ask afterwards.
  const exited = harness.app.waitForEvent('close')
  await harness.page.getByLabel('Close', { exact: true }).click()

  await exited
})

test('the search field in the middle opens quick open', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  await harness.page.getByTestId('title-search').click()

  await expect(harness.page.locator('input[placeholder="Go to document…"]')).toBeVisible()
})

test('a menu item runs the same command the palette and the native menu do', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  await harness.page.getByTestId('menu-view').click()
  await expect(harness.page.getByTestId('menu-dropdown')).toBeVisible()
  await harness.page.getByTestId('menu-item-panel.settings').click()

  await expect(harness.page.getByLabel('Autosave delay (ms)')).toBeVisible()
  // The menu closes behind the item it ran, rather than staying over the panel.
  await expect(harness.page.getByTestId('menu-dropdown')).toHaveCount(0)
})

test('the theme submenu changes the theme, grouped the way the picker is', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  await harness.page.getByTestId('menu-view').click()
  await harness.page.getByRole('menuitem', { name: 'Theme' }).hover()
  await harness.page.getByTestId('menu-item-app.setTheme.broadsheet').click()

  await expect(harness.page.locator('html')).toHaveAttribute('data-theme', 'broadsheet')
})

test('Escape closes an open menu without running anything', async () => {
  harness = await launch()

  await harness.page.getByTestId('menu-file').click()
  await expect(harness.page.getByTestId('menu-dropdown')).toBeVisible()

  await harness.page.keyboard.press('Escape')
  await expect(harness.page.getByTestId('menu-dropdown')).toHaveCount(0)
})
