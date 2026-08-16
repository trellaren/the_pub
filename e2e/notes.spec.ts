import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { NoteFile } from '../src/shared/model/note.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

function notesFile(docId: string): string {
  return path.join(harness.projectDir, '.thepub', 'notes', `${docId}.json`)
}

async function readNotes(docId: string): Promise<NoteFile> {
  return readJson<NoteFile>(notesFile(docId))
}

async function editor() {
  const locator = harness.page.locator('.pub-sheet:visible .ProseMirror').first()
  await expect(locator).toBeVisible()
  return locator
}

/**
 * Replace the document's whole text, leaving the caret at the end.
 *
 * Waits for the typed text to actually land in the DOM before returning —
 * under load, `selectRange`'s first keystroke can otherwise race a still-in-
 * flight keystroke from typing, landing the selection a character or two off
 * from where the test expects it.
 */
async function setText(text: string): Promise<void> {
  const el = await editor()
  await el.click()
  await harness.page.keyboard.press('ControlOrMeta+a')
  await harness.page.keyboard.type(text)
  await expect(el).toContainText(text)
}

/**
 * Select `[start, end)` of the (single-paragraph) document by keyboard.
 *
 * Presses through the locator, not the page-level keyboard: under load, ambient
 * OS focus can slip away between keystrokes (an autosave-triggered re-render is
 * enough), and a `page.keyboard.press` that lands on the wrong element fails
 * silently rather than failing loudly. Re-focusing the editor on every press
 * costs a little time and buys determinism.
 */
async function selectRange(start: number, end: number): Promise<void> {
  const el = await editor()
  await el.press('Home')
  for (let i = 0; i < start; i++) await el.press('ArrowRight')
  for (let i = 0; i < end - start; i++) await el.press('Shift+ArrowRight')
}

async function addNoteButton() {
  return harness.page.getByRole('button', { name: 'Add note' })
}

async function showNotes(): Promise<void> {
  await harness.page.evaluate(() => window.__pub.runCommand('panel.notes'))
}

test('the Add note button is disabled until text is selected', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('The quick brown fox jumps.')

  await expect(await addNoteButton()).toBeDisabled()

  await selectRange(4, 15)
  await expect(await addNoteButton()).toBeEnabled()
})

test('adding a note from the toolbar attaches it to the selection and persists it', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('The quick brown fox jumps.')
  await selectRange(4, 15)

  await (await addNoteButton()).click()

  await expect(harness.page.locator('text=“quick brown”')).toBeVisible()

  await waitFor(async () => {
    const file = await readNotes(docId).catch(() => null)
    return file !== null && file.notes.length === 1
  }, 'the note to reach its sidecar file')

  const stored = await readNotes(docId)
  expect(stored.notes[0]).toMatchObject({ docId, anchorText: 'quick brown', blockIndex: 0, orphaned: false })
})

test('editing a note body persists it, and resolving it persists too', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('The quick brown fox jumps.')
  await selectRange(4, 15)
  await (await addNoteButton()).click()
  await waitFor(async () => (await readNotes(docId).catch(() => null))?.notes.length === 1, 'the note to be created')

  const noteBody = harness.page.locator('.pub-notes').last()
  await expect(noteBody).toBeVisible()
  await noteBody.click()
  await harness.page.keyboard.type('Reconsider this description.')

  await harness.page.getByLabel('Resolved').check()

  await waitFor(async () => {
    const file = await readNotes(docId)
    const note = file.notes[0]!
    return note.resolved === true && JSON.stringify(note.body).includes('Reconsider this description.')
  }, 'the note edit and resolved flag to be saved')
})

test('deleting a note removes it from the panel and its file', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('The quick brown fox jumps.')
  await selectRange(4, 15)
  await (await addNoteButton()).click()
  await waitFor(async () => (await readNotes(docId).catch(() => null))?.notes.length === 1, 'the note to be created')

  await harness.page.getByRole('button', { name: 'Delete note' }).click()

  await expect(harness.page.locator('text=“quick brown”')).toHaveCount(0)
  await waitFor(async () => (await readNotes(docId)).notes.length === 0, 'the note to be removed from disk')
})

test('rewriting the anchored text orphans the note, and a matching candidate re-attaches it', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  await setText('The quick brown fox jumps.')
  await selectRange(4, 15)
  await (await addNoteButton()).click()
  await waitFor(async () => (await readNotes(docId).catch(() => null))?.notes.length === 1, 'the note to be created')

  // Replace the whole document, dropping the anchored phrase entirely, then
  // save — the same `doc:write` path production autosave uses.
  await setText('Nothing here resembles the old sentence.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  await waitFor(async () => (await readNotes(docId)).notes[0]!.orphaned === true, 'the note to be orphaned')

  await showNotes()
  await expect(harness.page.locator("text=This note's text is no longer in the document.")).toBeVisible()

  // Bring the phrase back, elsewhere in the document, and offer it as a candidate.
  await setText('First, an unrelated line. Then: quick brown returns here.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  const candidate = harness.page.getByRole('button', { name: /Attach to occurrence/ })
  await expect(candidate).toBeVisible()
  await candidate.click()

  await waitFor(async () => {
    const note = (await readNotes(docId)).notes[0]!
    return note.orphaned === false && note.blockIndex === 0
  }, 'the note to be re-attached')
})
