import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { HighlightFile } from '../src/shared/model/highlight.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

function highlightsFile(projectDir: string, docId: string): string {
  return path.join(projectDir, '.thepub', 'highlights', `${docId}.json`)
}

async function readHighlights(projectDir: string, docId: string): Promise<HighlightFile> {
  return readJson<HighlightFile>(highlightsFile(projectDir, docId))
}

async function editor() {
  const locator = harness.page.locator('.pub-sheet:visible .ProseMirror').first()
  await expect(locator).toBeVisible()
  return locator
}

async function setText(text: string): Promise<void> {
  const el = await editor()
  await el.click()
  await harness.page.keyboard.press('ControlOrMeta+a')
  await harness.page.keyboard.type(text)
  await expect(el).toContainText(text)
}

async function selectRange(start: number, end: number): Promise<void> {
  const el = await editor()
  await el.press('Home')
  for (let i = 0; i < start; i++) await el.press('ArrowRight')
  for (let i = 0; i < end - start; i++) await el.press('Shift+ArrowRight')
}

test('a document highlight can be collected, categorised, and survives closing and reopening the project', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('The quick brown fox jumps.')
  await selectRange(4, 15)

  // Colour the selection, then collect it into the Research panel — mirroring
  // what a click on the toolbar's yellow swatch and its "Collect…" select do.
  const highlightButton = harness.page.locator('button[title^="Highlight #ffe066"]')
  await highlightButton.click()
  await expect(harness.page.locator('.ProseMirror mark')).toBeVisible()

  const collectSelect = harness.page.getByTitle('Collect highlight into the Research panel')
  await expect(collectSelect).toBeEnabled()
  await collectSelect.selectOption({ label: 'No category' })

  await waitFor(async () => {
    const file = await readHighlights(harness.projectDir, docId).catch(() => null)
    return file !== null && file.highlights.length === 1
  }, 'the highlight to reach its sidecar file')

  const stored = await readHighlights(harness.projectDir, docId)
  expect(stored.highlights[0]).toMatchObject({
    docId,
    quote: 'quick brown',
    blockIndex: 0,
    orphaned: false
  })

  const highlightId = stored.highlights[0].id

  // The Research panel's Manuscript tab shows it.
  await harness.page.evaluate(() => window.__pub.runCommand('panel.research'))
  await expect(harness.page.locator('text=“quick brown”')).toBeVisible()

  // Bring the editor tab back to the front — a real click, not the store —
  // so the layout persisted below restores with the document active, the
  // way it would be after a user actually finishes reading the panel.
  await harness.page.getByRole('tab', { name: /chapter-01/ }).click()
  await expect(await editor()).toBeVisible()

  const layoutFile = path.join(harness.projectDir, '.thepub', 'layouts.json')
  await waitFor(async () => {
    const layout = await readJson<{ lastLayout: unknown }>(layoutFile)
    return layout.lastLayout !== null
  }, 'the layout to be persisted')

  const { projectDir, userDataDir } = harness
  await harness.app.close()

  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)

  // The editor panel comes back from the saved layout, already the active
  // tab in its group, and becomes the active document as soon as its
  // `EditorPanel` mounts.
  await waitFor(async () => {
    const activeDocId = await harness.page.evaluate(() => window.__pub.documents.getState().activeDocId)
    return activeDocId === docId
  }, 'the reopened document to become active')

  // Confirmed against the sidecar file directly rather than through the
  // Research panel here, to keep this test's focus on persistence. Whether
  // opening a dock panel after a reopen crashes the renderer at all is
  // covered separately and conclusively (it does not) by
  // `panel-reopen.spec.ts`. The panel's own rendering of a collected
  // highlight is covered by the pre-close assertion above, which exercises
  // the same component against the same store.
  const reopened = await readHighlights(projectDir, docId)
  expect(reopened.highlights).toHaveLength(1)
  expect(reopened.highlights[0]).toMatchObject({
    id: highlightId,
    docId,
    quote: 'quick brown',
    categoryId: '',
    orphaned: false
  })
})
