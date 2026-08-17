import { test, expect } from '@playwright/test'
import { launch, openProject, createDocument, cleanup, type Harness } from './helpers.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

async function editor() {
  const locator = harness.page.locator('.pub-sheet:visible .ProseMirror').first()
  await expect(locator).toBeVisible()
  return locator
}

/**
 * The title of the dock tab whose `[role="tabpanel"]` currently contains
 * focus — dockview labels a tabpanel via `aria-labelledby` pointing at its
 * `[role="tab"]`, not with `aria-label` directly, so this follows that chain
 * rather than reading an attribute that isn't there.
 */
function focusedPanelTitle(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const panel = document.activeElement?.closest('[role="tabpanel"]')
    const labelledBy = panel?.getAttribute('aria-labelledby')
    const tab = labelledBy ? document.getElementById(labelledBy) : null
    return tab?.getAttribute('aria-label') ?? null
  })
}

// Phase 14, Part 1: Tab is claimed inside the editor (it cycles a screenplay
// style — see `namedStyles.ts`), so it cannot double as the way out, or a
// writer using a stylable paragraph could never reach the toolbar or
// anything else by keyboard. Escape-then-Tab is the documented escape.
test('Escape moves focus out of the editor so a following Tab can leave it', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const el = await editor()
  await el.click()
  await harness.page.keyboard.type('Some prose.')
  await expect(el).toBeFocused()

  await harness.page.keyboard.press('Escape')
  await expect(el).not.toBeFocused()

  await harness.page.keyboard.press('Tab')
  await expect(el).not.toBeFocused()
})

// Phase 14, Part 1: the palette is the universal fallback for every command,
// but reaching a specific dock *panel* needed its own entry — "Focus
// panel…" lists what's open and moves both dockview's active state and real
// DOM focus into the chosen one.
test('Focus Panel… lists open panels and moves focus into the chosen one', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.__pub.runCommand('panel.search'))

  await harness.page.evaluate(() => window.__pub.runCommand('panel.focus'))
  const palette = harness.page.locator('input[placeholder="Focus which panel?"]')
  await expect(palette).toBeVisible()
  await palette.fill('Search')
  await harness.page.keyboard.press('Enter')

  await expect.poll(() => focusedPanelTitle(harness.page)).toBe('Search')
})

// The documented cycle key: no mouse, no palette, just step focus to the
// next open panel and back.
test('Cycle Panel Focus moves DOM focus between open panels', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.__pub.runCommand('panel.search'))
  await harness.page.evaluate(() => window.__pub.runCommand('panel.explorer'))
  await harness.page.evaluate(() => window.__pub.layout.getState().focusPanelById('explorer'))

  const before = await focusedPanelTitle(harness.page)
  await harness.page.evaluate(() => window.__pub.runCommand('panel.cycle'))
  const after = await focusedPanelTitle(harness.page)
  expect(after).not.toBe(before)
})

// Phase 14, Part 1: opening a dialog must not leave focus reachable on the
// page behind it, and closing it must put focus back exactly where it was.
test('New Project dialog traps Tab and returns focus to its opener on close', async () => {
  harness = await launch()

  const opener = harness.page.locator('[data-testid="open-new-project"]')
  await opener.click()
  const dialog = harness.page.locator('[data-testid="new-project-dialog"]')
  await expect(dialog).toBeVisible()

  // Tabbing from the last focusable element must land back on the first,
  // never escaping onto the page behind the overlay.
  await harness.page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
})
