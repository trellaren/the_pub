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
