import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { PubDocument } from '../src/shared/model/document.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

async function writeSomething(): Promise<void> {
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror').first()
  await editor.click()
  await harness.page.keyboard.type('Still here.')
  await expect(editor).toContainText('Still here.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
}

async function deleteAndWait(file: string): Promise<void> {
  await fs.rm(path.join(harness.projectDir, file))
  await expect(harness.page.getByText('This file no longer exists')).toBeVisible({ timeout: 20000 })
}

test('a tab whose file was deleted can be saved to a new file', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await writeSomething()
  await deleteAndWait('chapter-01.pubdoc')
  await harness.page.getByTestId('missing-save-as').click()
  await harness.page.getByTestId('prompt-input').fill('rescued')
  await harness.page.getByTestId('prompt-confirm').click()

  const rescued = path.join(harness.projectDir, 'rescued.pubdoc')
  await waitFor(async () => {
    const doc = await readJson<PubDocument>(rescued).catch(() => null)
    return doc !== null && JSON.stringify(doc.content).includes('Still here.')
  }, 'the buffer to be written to the new file')
  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror').first()).toContainText('Still here.')
})

test('a tab whose file was deleted can be closed', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await writeSomething()
  await deleteAndWait('chapter-01.pubdoc')
  await harness.page.getByTestId('missing-close').click()
  await expect(harness.page.getByText('This file no longer exists')).toHaveCount(0)
  await expect
    .poll(() => harness.page.evaluate(() => Object.values(window.__pub.documents.getState().docs).some((d) => d.path === 'chapter-01.pubdoc')))
    .toBe(false)
})
