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

async function setText(text: string): Promise<void> {
  const el = await editor()
  await el.click()
  await harness.page.keyboard.press('ControlOrMeta+a')
  await harness.page.keyboard.type(text)
  await expect(el).toContainText(text)
}

test('inserting a footnote opens it for editing, numbered, and closes on outside click', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  const el = await editor()
  await el.click()
  await harness.page.keyboard.press('ControlOrMeta+a')
  // A second, textually distinct paragraph gives "click elsewhere" an
  // unambiguous target — the first paragraph's own text becomes a substring
  // of its combined-with-footnote text once the note is open and typed into,
  // which a plain click on "its own text" can no longer reliably find.
  await harness.page.keyboard.type('A claim needing support.')
  await harness.page.keyboard.press('Enter')
  await harness.page.keyboard.type('Elsewhere.')
  await expect(el).toContainText('Elsewhere.')

  await harness.page.keyboard.press('ArrowUp')
  await harness.page.keyboard.press('End')
  await harness.page.getByRole('button', { name: 'Insert footnote' }).click()

  const marker = harness.page.locator('.pub-footnote')
  await expect(marker).toHaveCount(1)
  await expect(marker).toHaveAttribute('data-number', '1')
  await expect(marker).toHaveClass(/is-open/)

  const body = marker.locator('.pub-footnote-body')
  await harness.page.keyboard.type('The supporting evidence.')
  await expect(body).toContainText('The supporting evidence.')

  // The open popover visually overlaps the paragraph below it — exactly the
  // "floats over adjacent content" a popover is supposed to do — so the close
  // click lands at the very start of the first paragraph's own line instead,
  // which the popover (anchored further right, near the marker) never covers.
  const firstParagraph = harness.page.locator('.ProseMirror p', { hasText: 'A claim needing support.' }).first()
  await firstParagraph.click({ position: { x: 2, y: 2 } })
  await expect(marker).not.toHaveClass(/is-open/)
})

test('a second footnote is numbered after the first, and Escape then a marker click reopens it', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('First claim. Second claim.')

  const el = await editor()
  await el.click()
  await harness.page.keyboard.press('ControlOrMeta+Home')
  for (let i = 0; i < 'First claim.'.length; i++) await harness.page.keyboard.press('ArrowRight')
  await harness.page.getByRole('button', { name: 'Insert footnote' }).click()
  await harness.page.keyboard.type('One.')

  await harness.page.keyboard.press('ControlOrMeta+End')
  await harness.page.getByRole('button', { name: 'Insert footnote' }).click()
  await harness.page.keyboard.type('Two.')

  const markers = harness.page.locator('.pub-footnote')
  await expect(markers).toHaveCount(2)
  await expect(markers.nth(0)).toHaveAttribute('data-number', '1')
  await expect(markers.nth(1)).toHaveAttribute('data-number', '2')
  await expect(markers.nth(1)).toHaveClass(/is-open/)

  await harness.page.keyboard.press('Escape')
  await expect(markers.nth(1)).not.toHaveClass(/is-open/)

  await markers.nth(0).click()
  await expect(markers.nth(0)).toHaveClass(/is-open/)
})

test('the endnotes region lists every footnote and jumps to it on click', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('A claim.')
  await harness.page.keyboard.press('End')
  await harness.page.getByRole('button', { name: 'Insert footnote' }).click()
  await harness.page.keyboard.type('Cited evidence.')
  await harness.page.getByText('A claim.').click()

  const endnotes = harness.page.locator('.pub-endnotes li')
  await expect(endnotes).toHaveCount(1)
  await expect(endnotes.first()).toContainText('Cited evidence.')

  await endnotes.first().locator('button').click()
  await expect(harness.page.locator('.pub-footnote')).toHaveClass(/is-open/)
})

test('a footnote survives closing and reopening the project', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('A claim.')
  await harness.page.keyboard.press('End')
  await harness.page.getByRole('button', { name: 'Insert footnote' }).click()
  await harness.page.keyboard.type('Persisted note.')
  await harness.page.getByText('A claim.').click()

  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
  const { projectDir, userDataDir } = harness
  await harness.app.close()

  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)
  await harness.page.evaluate(async (target) => {
    const documents = window.__pub.documents.getState()
    const id = await documents.openPath(target)
    const state = window.__pub.documents.getState().docs[id!]!
    window.__pub.layout.getState().openEditor(id!, state.path, state.title)
  }, 'chapter-01.pubdoc')

  const marker = harness.page.locator('.pub-footnote')
  await expect(marker).toHaveCount(1)
  await expect(harness.page.locator('.pub-endnotes')).toContainText('Persisted note.')
})
