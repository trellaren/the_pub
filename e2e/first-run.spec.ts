import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launch, openProject, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { PubDocument } from '../src/shared/model/document.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

const SHEET = '.pub-sheet:visible'

test('opening an empty project lands in a fresh page, and what is typed there survives', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  // No clicks, no "new document" — the folder was empty, so the first
  // document is made and opened as part of arriving.
  await expect(harness.page.locator(SHEET)).toBeVisible()
  await waitFor(
    async () =>
      fs.access(path.join(harness.projectDir, 'untitled.pubdoc')).then(() => true, () => false),
    'the first document to reach disk'
  )

  await harness.page.locator(`${SHEET} .ProseMirror`).click()
  await harness.page.keyboard.type('It was a dark and stormy night.')
  await expect(harness.page.locator(`${SHEET} .ProseMirror`)).toContainText('stormy')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  const { projectDir, userDataDir } = harness
  await harness.app.close()
  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)

  await expect(harness.page.locator(`${SHEET} .ProseMirror`)).toContainText('stormy')
  // Exactly one document was ever created: reopening must not mint another.
  const files = (await fs.readdir(projectDir)).filter((name) => name.endsWith('.pubdoc'))
  expect(files).toEqual(['untitled.pubdoc'])
})

test('a project that already has documents opens one instead of inventing another', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await expect(harness.page.locator(SHEET)).toBeVisible()
  const { projectDir } = harness
  await cleanup(harness)

  // Fresh user data: no saved layout to restore, so the fallback itself must
  // find the existing document rather than create a second.
  harness = await launch({ projectDir })
  await openProject(harness.page, projectDir)
  await expect(harness.page.locator(SHEET)).toBeVisible()
  const files = (await fs.readdir(projectDir)).filter((name) => name.endsWith('.pubdoc'))
  expect(files).toEqual(['untitled.pubdoc'])
})

test('double-clicking the tab renames the document, and the name survives a reopen', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await expect(harness.page.locator(SHEET)).toBeVisible()

  const tab = harness.page.getByTestId('dockview-dv-default-tab').filter({ hasText: 'untitled' })
  await tab.dblclick()
  const input = harness.page.getByTestId('tab-rename').locator('input')
  await expect(input).toBeVisible()
  await input.fill('Chapter One')
  await input.press('Enter')

  // The tab shows the new name, and the envelope carries it — the same field
  // the Manuscript panel and Word export read.
  await expect(
    harness.page.getByTestId('dockview-dv-default-tab').filter({ hasText: 'Chapter One' })
  ).toBeVisible()
  await waitFor(async () => {
    const doc = await readJson<PubDocument>(path.join(harness.projectDir, 'untitled.pubdoc'))
    return doc.title === 'Chapter One'
  }, 'the rename to reach the envelope on disk')

  const { projectDir, userDataDir } = harness
  await harness.app.close()
  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)
  await expect(
    harness.page.getByTestId('dockview-dv-default-tab').filter({ hasText: 'Chapter One' })
  ).toBeVisible()
})

test('pressing Escape abandons a rename instead of committing it', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await expect(harness.page.locator(SHEET)).toBeVisible()

  await harness.page.getByTestId('dockview-dv-default-tab').filter({ hasText: 'untitled' }).dblclick()
  const input = harness.page.getByTestId('tab-rename').locator('input')
  await input.fill('Not this')
  await input.press('Escape')

  await expect(harness.page.getByTestId('tab-rename')).toHaveCount(0)
  await expect(
    harness.page.getByTestId('dockview-dv-default-tab').filter({ hasText: 'untitled' })
  ).toBeVisible()
  const doc = await readJson<PubDocument>(path.join(harness.projectDir, 'untitled.pubdoc'))
  expect(doc.title).not.toBe('Not this')
})

test('a new document is a full page, not a strip the height of one paragraph', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await expect(harness.page.locator(SHEET)).toBeVisible()

  /*
   * 792pt (US Letter) is 1056 CSS pixels. The sheet of an empty document must
   * already stand that tall — the "short snippet" this guards against was a
   * sheet that hugged its single empty paragraph.
   */
  const box = await harness.page.locator(SHEET).boundingBox()
  expect(box).not.toBeNull()
  expect(box!.height).toBeGreaterThanOrEqual(1050)

  // And the blank expanse is the page: clicking low on the sheet focuses the
  // editor rather than doing visibly nothing.
  await harness.page.locator(SHEET).click({ position: { x: box!.width / 2, y: box!.height - 40 } })
  await harness.page.keyboard.type('Typed after clicking the empty page.')
  await expect(harness.page.locator(`${SHEET} .ProseMirror`)).toContainText(
    'Typed after clicking the empty page.'
  )
})
