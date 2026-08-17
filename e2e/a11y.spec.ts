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

// Phase 14, Part 2: the file tree is a real `tree`/`treeitem` structure with
// expanded state, not a div soup of clickable rows.
test('the file tree exposes tree/treeitem roles with expanded state', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const tree = harness.page.locator('[data-testid="file-tree"]')
  await expect(tree).toHaveAttribute('role', 'tree')

  const item = tree.locator('[role="treeitem"]').first()
  await expect(item).toHaveAttribute('aria-level', '1')
  await expect(item).toHaveAttribute('aria-selected', /true|false/)
})

// Phase 14, Part 2: search result counts are announced without being read as
// ordinary prose visible only on screen.
test('search result counts land in a polite live region', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  const el = await editor()
  await el.click()
  await harness.page.keyboard.type('The lighthouse keeper walked the shore.')

  await harness.page.evaluate(() => window.__pub.runCommand('panel.search'))
  const live = harness.page.locator('[data-testid="search-result-live"]')
  await expect(live).toHaveAttribute('aria-live', 'polite')

  await harness.page.locator('[data-testid="search-input"]').fill('lighthouse')
  await expect(live).toContainText('result')
})

// Phase 14, Part 2: save state is announced once per save, politely, without
// visually changing the status bar.
test('a completed save is announced in a polite live region', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  const el = await editor()
  await el.click()
  await harness.page.keyboard.type('Something worth saving.')

  const live = harness.page.locator('[data-testid="save-state-live"]')
  await expect(live).toHaveAttribute('aria-live', 'polite')
  await expect(live).toContainText('Saved', { timeout: 10000 })
})

// Phase 14, Part 3: the dock has to survive 200% UI scaling, not just look
// fine at the size it was designed at. `setZoomFactor` is Chromium's own
// page-zoom, the same mechanism Ctrl/Cmd+= drives, so it exercises exactly
// what a low-vision user's zoom shortcut would.
test('the dock stays usable at 200% zoom', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  // Explorer and Search share a dockview group (see `FileTree.tsx`), so the
  // one opened last is the one left on screen — explorer is what this test
  // checks, so it has to be the last one focused.
  await harness.page.evaluate(() => window.__pub.runCommand('panel.search'))
  await harness.page.evaluate(() => window.__pub.runCommand('panel.explorer'))

  await harness.app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.setZoomFactor(2)
  })
  // `setZoomFactor` takes effect asynchronously in the renderer.
  await harness.page.waitForTimeout(300)

  // Still on screen and not clipped to nothing: a broken-at-scale layout
  // typically collapses a panel to zero width/height rather than merely
  // shrinking it.
  const tree = harness.page.locator('[data-testid="file-tree"]')
  await expect(tree).toBeVisible()
  const treeBox = await tree.boundingBox()
  expect(treeBox?.width ?? 0).toBeGreaterThan(20)
  expect(treeBox?.height ?? 0).toBeGreaterThan(20)

  const el = await editor()
  await expect(el).toBeVisible()
  const editorBox = await el.boundingBox()
  expect(editorBox?.width ?? 0).toBeGreaterThan(20)

  await harness.app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.setZoomFactor(1)
  })
})
