import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { ReviewFile } from '../src/shared/model/review.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

function reviewsDir(docId: string): string {
  return path.join(harness.projectDir, '.thepub', 'reviews', docId)
}

/** Whoever this machine is — the id is minted in app state, not chosen by a test. */
async function reviewFile(docId: string): Promise<ReviewFile> {
  const files = await fs.readdir(reviewsDir(docId))
  const first = files.find((name) => name.endsWith('.json'))
  if (!first) throw new Error('no review file yet')
  return readJson<ReviewFile>(path.join(reviewsDir(docId), first))
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

async function addComment(): Promise<void> {
  await harness.page.getByRole('button', { name: 'Add comment' }).click()
}

test('the Add comment button is disabled until text is selected', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('The harbour was quiet that evening.')

  await expect(harness.page.getByRole('button', { name: 'Add comment' })).toBeDisabled()
  await selectRange(4, 11)
  await expect(harness.page.getByRole('button', { name: 'Add comment' })).toBeEnabled()
})

test('a comment survives closing and reopening the project', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('The harbour was quiet that evening.')
  await selectRange(4, 11)
  await addComment()

  await waitFor(async () => {
    const file = await reviewFile(docId).catch(() => null)
    return file !== null && file.threads.length === 1
  }, 'the comment to reach its per-author file')

  // The proof this repo asks of any renderer feature: not that the store holds
  // it, but that a fresh process reading the folder finds it again.
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.__pub.runCommand('panel.review'))
  await expect(harness.page.locator('text=“harbour”')).toBeVisible()
})

test('a reply and a resolution are written to the same author’s file', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('The harbour was quiet that evening.')
  await selectRange(4, 11)
  await addComment()
  await waitFor(async () => (await reviewFile(docId).catch(() => null))?.threads.length === 1, 'the comment')

  const reply = harness.page.getByPlaceholder('Reply…').first()
  await reply.click()
  await reply.fill('Too flat — try a sound instead.')
  await reply.press('Enter')

  await waitFor(async () => (await reviewFile(docId)).replies.length === 1, 'the reply to be saved')

  await harness.page.getByLabel('Resolved').first().check()
  await waitFor(async () => (await reviewFile(docId)).threads[0]!.status === 'resolved', 'the resolution')
})

test('suggesting mode proposes a deletion instead of performing one', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('The harbour was quiet that evening.')

  await harness.page.evaluate(() => window.__pub.runCommand('panel.review'))
  await harness.page.getByLabel('Suggest changes instead of making them').check()

  // Back into the editor first: the checkbox took focus, and a contenteditable
  // that is focused without being clicked has no caret for Home to move.
  const el = await editor()
  await el.click()
  await selectRange(4, 12)
  await el.press('Backspace')

  // The whole point: the words are still there, struck through, waiting for a
  // verdict — a suggestion to delete that deleted anything would not be one.
  // The visible strikethrough text, not the leading screen-reader-only label
  // this mark now also renders.
  await expect(harness.page.locator('.pub-deletion')).toContainText('harbour')
  await expect(el).toContainText('harbour')
})

test('rejecting one suggestion leaves the same author’s others pending', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('Alpha beta.')
  // The editor's own text, not the DOM's: each suggestion also renders a
  // screen-reader label that would interleave with the words.
  const plain = () => harness.page.evaluate((id) => window.__pub.getEditor(id)!.getText(), docId)

  await harness.page.evaluate(() => window.__pub.runCommand('panel.review'))
  await harness.page.getByLabel('Suggest changes instead of making them').check()

  const el = await editor()
  await el.click()
  await el.press('End')
  for (const key of [' ', 'o', 'n', 'e']) await el.press(key)
  await expect.poll(plain).toBe('Alpha beta. one')
  await el.press('Home')
  for (const key of ['t', 'w', 'o', ' ']) await el.press(key)
  await expect.poll(plain).toBe('two Alpha beta. one')

  // Listed live, without the panel being poked: two edits by one author.
  const rows = harness.page.getByTestId('suggestion-row')
  await expect(rows).toHaveCount(2)

  await rows.first().getByRole('button', { name: 'Reject' }).click()
  await expect(rows).toHaveCount(1)
  await expect.poll(plain).toBe('Alpha beta. one')
  await expect(harness.page.locator('.pub-insertion').first()).toBeVisible()

  await harness.page.getByTestId('suggestions-accept-all').click()
  await expect(rows).toHaveCount(0)
  await expect(harness.page.locator('.pub-insertion')).toHaveCount(0)
  await expect.poll(plain).toBe('Alpha beta. one')
})

test('suggesting mode follows into editors opened after it was turned on', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('First chapter.')

  await harness.page.evaluate(() => window.__pub.runCommand('panel.review'))
  await harness.page.getByLabel('Suggest changes instead of making them').check()

  await createDocument(harness.page, 'chapter-02.pubdoc')
  const el = await editor()
  await el.click()
  for (const key of ['N', 'e', 'w']) await el.press(key)

  await expect(harness.page.locator('.pub-sheet:visible .pub-insertion').first()).toBeVisible()
  await expect(harness.page.getByTestId('suggesting-indicator').filter({ visible: true })).toBeVisible()
})
