import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { PubDocument } from '../src/shared/model/document.js'

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

async function setStyle(styleId: string): Promise<void> {
  await harness.page.locator('select[title="Paragraph style"]:visible').selectOption(styleId)
}

/** Build a document with two headings and a paragraph, ready for TOC/reference tests. */
async function buildOutline(): Promise<void> {
  await setText('Chapter One')
  await setStyle('heading-1')
  await harness.page.keyboard.press('End')
  await harness.page.keyboard.press('Enter')
  await setStyle('first-paragraph')
  await harness.page.keyboard.type('Some prose here.')
  await harness.page.keyboard.press('Enter')
  await setStyle('heading-2')
  await harness.page.keyboard.type('A scene')
  await harness.page.keyboard.press('End')
  await harness.page.keyboard.press('Enter')
  await setStyle('first-paragraph')
  await harness.page.keyboard.type('More prose.')
}

async function storedDocument(file = 'chapter-01.pubdoc'): Promise<PubDocument> {
  return readJson<PubDocument>(path.join(harness.projectDir, file))
}

test('Insert / update table of contents lists headings in order, with their level', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await buildOutline()

  await harness.page.getByRole('button', { name: 'Insert / update table of contents' }).click()

  const entries = harness.page.locator('[data-field="toc"]')
  await expect(entries).toHaveCount(2)
  await expect(entries.nth(0)).toHaveText('Chapter One')
  await expect(entries.nth(1)).toHaveText('A scene')

  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
  await waitFor(async () => {
    const doc = await storedDocument()
    const first = doc.content.content?.[0]
    return first?.type === 'paragraph' && first.content?.[0]?.type === 'field'
  }, 'the table of contents to be saved')
})

test('the table of contents is refreshed in place, not duplicated, on a second click', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await buildOutline()

  const tocButton = harness.page.getByRole('button', { name: 'Insert / update table of contents' })
  await tocButton.click()
  await tocButton.click()
  await tocButton.click()

  await expect(harness.page.locator('[data-field="toc"]')).toHaveCount(2)
})

test('inserting a cross-reference embeds the target heading’s text, and clicking it jumps there', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await buildOutline()

  // Place the cursor at the end of the first paragraph, then insert a
  // reference to whichever heading the picker's first real option names.
  const el = await editor()
  await el.click()
  await harness.page.keyboard.press('ControlOrMeta+Home')
  await harness.page.getByText('Some prose here.').click()
  await harness.page.keyboard.press('End')

  const picker = harness.page.locator('select[title="Insert cross-reference"]:visible')
  const targetLabel = await picker.locator('option').nth(1).textContent()
  await picker.selectOption({ index: 1 })

  const refField = harness.page.locator('[data-field="ref"]')
  await expect(refField).toHaveCount(1)
  expect((await refField.textContent())?.trim()).toBe(targetLabel?.trim())

  await refField.click()
  const landedInHeading = await harness.page.evaluate(() => {
    const selection = window.getSelection()
    const node = selection?.anchorNode
    const element = node instanceof Element ? node : node?.parentElement
    return Boolean(element?.closest('h1, h2, h3, h4, h5, h6'))
  })
  expect(landedInHeading).toBe(true)
})

test('a reference survives closing and reopening the project, still pointing at its target', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await buildOutline()

  const el = await editor()
  await el.click()
  await harness.page.keyboard.press('ControlOrMeta+Home')
  await harness.page.getByText('Some prose here.').click()
  await harness.page.keyboard.press('End')
  await harness.page.locator('select[title="Insert cross-reference"]:visible').selectOption({ index: 1 })

  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
  await waitFor(async () => {
    const doc = await storedDocument()
    return JSON.stringify(doc.content).includes('"type":"field"')
  }, 'the reference to be saved')

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
  await expect(harness.page.locator('[data-field="ref"]')).toHaveCount(1)
})
