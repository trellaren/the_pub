import { test, expect } from '@playwright/test'
import { launch, openProject, cleanup, type Harness } from './helpers.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

test('the menu bar is reachable and usable from the keyboard alone', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const page = harness.page
  const start = page.getByTestId('title-search')
  await start.focus()

  await page.keyboard.press('F10')
  await expect(page.getByTestId('menu-file')).toBeFocused()

  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('menu-file')).not.toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('menu-file')).toBeFocused()

  await page.keyboard.press('ArrowDown')
  const dropdown = page.getByTestId('menu-dropdown')
  await expect(dropdown).toBeVisible()
  const first = dropdown.getByRole('menuitem').first()
  await expect(first).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(first).not.toBeFocused()

  await page.keyboard.press('Escape')
  await expect(dropdown).toHaveCount(0)
  await expect(page.getByTestId('menu-file')).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(start).toBeFocused()
})

test('Enter on a menu item runs it and hands focus back', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const page = harness.page
  await page.getByTestId('title-search').focus()

  await page.keyboard.press('F10')
  await page.keyboard.press('Enter')
  const close = page.getByTestId('menu-item-project.close')
  for (let step = 0; step < 20 && !(await close.evaluate((el) => el === document.activeElement)); step++) {
    await page.keyboard.press('ArrowDown')
  }
  await expect(close).toBeFocused()
  await page.keyboard.press('Enter')

  await expect.poll(() => page.evaluate(() => window.__pub.project.getState().project)).toBeNull()
  await expect(page.getByTestId('menu-dropdown')).toHaveCount(0)
})
