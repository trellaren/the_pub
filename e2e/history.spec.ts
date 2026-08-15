import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { PubDocument } from '../src/shared/model/document.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

/**
 * Version history, through the panel.
 *
 * The backend has been archiving a version on every save since the app was
 * built; nothing could open one until now, so all of this is new ground.
 *
 * History is *written* on a ten-minute throttle, so a session can only ever
 * produce one version by typing — which is right for an author and useless for
 * a test. Rather than fake a clock, these seed the archive the same way
 * `SnapshotService` does, a JSON file per version under `.thepub/snapshots`,
 * and then exercise the real reading, comparing and restoring paths against it.
 */

async function docIdOf(file: string): Promise<string> {
  return (await readJson<PubDocument>(path.join(harness.projectDir, file))).docId
}

/** A stored version, written exactly as the service writes one. */
async function writeVersion(docId: string, when: string, paragraphs: string[]): Promise<void> {
  const dir = path.join(harness.projectDir, '.thepub', 'snapshots', docId)
  await fs.mkdir(dir, { recursive: true })
  const doc = {
    formatVersion: 1,
    docId,
    title: 'chapter-01',
    created: when,
    modified: when,
    wordCount: 0,
    content: {
      type: 'doc',
      content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
    }
  }
  await fs.writeFile(path.join(dir, `${when.replace(/[:.]/g, '-')}.json`), JSON.stringify(doc), 'utf8')
}

async function showHistory(): Promise<void> {
  await harness.page.evaluate(() => window.__pub.runCommand('panel.history'))
  await expect(harness.page.getByTestId('history-list')).toBeVisible()
  await harness.page.evaluate(() => window.__pub.history.getState().refresh())
}

/** Bring the document back to the front; the panel opens over it. */
async function showEditor(file: string): Promise<void> {
  await harness.page.evaluate((target) => {
    const documents = window.__pub.documents.getState()
    const state = Object.values(documents.docs).find((doc) => doc.path.endsWith(target))
    if (state) window.__pub.layout.getState().openEditor(state.docId, state.path, state.title)
  }, file)
  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror').first()).toBeVisible()
}

async function type(text: string): Promise<void> {
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror').first()
  await expect(editor).toBeVisible()
  await editor.click()
  await harness.page.keyboard.press('ControlOrMeta+a')
  await harness.page.keyboard.type(text)
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
}

async function storedText(file = 'chapter-01.pubdoc'): Promise<string> {
  return JSON.stringify((await readJson<PubDocument>(path.join(harness.projectDir, file))).content)
}

async function versionCount(): Promise<number> {
  await harness.page.evaluate(() => window.__pub.history.getState().refresh())
  return harness.page.evaluate(() => window.__pub.history.getState().snapshots.length)
}

test('earlier versions are listed newest first, and one can be read', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  const docId = await docIdOf('chapter-01.pubdoc')
  await writeVersion(docId, '2026-08-01T09:00:00.000Z', ['The oldest draft.'])
  await writeVersion(docId, '2026-08-10T09:00:00.000Z', ['The newer draft.'])

  await showHistory()
  const items = harness.page.getByTestId('history-item')
  await expect(items).toHaveCount(2)

  // The one you want back is nearly always a recent one, so it is at the top.
  await items.first().click()
  const preview = harness.page.getByTestId('history-version')
  await expect(preview).toContainText('The newer draft.')

  // Read-only: a version is a record of what was written, not somewhere to write.
  await expect(preview.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false')

  await items.last().click()
  await expect(preview).toContainText('The oldest draft.')
})

test('comparing a version with the current one names what changed', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  const docId = await docIdOf('chapter-01.pubdoc')

  // The old version: three paragraphs, one of which will be edited and one of
  // which will travel to the end.
  await writeVersion(docId, '2026-08-01T09:00:00.000Z', [
    'Alpha.',
    'The storm broke at dusk.',
    'Charlie.'
  ])

  await type('The storm broke at dawn.')
  await harness.page.keyboard.press('Enter')
  await harness.page.keyboard.type('Charlie.')
  await harness.page.keyboard.press('Enter')
  await harness.page.keyboard.type('Alpha.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  await showHistory()
  // The oldest: the seeded version. The first save of the document archives the
  // empty page it started as, so the newest entry is that, not this.
  await harness.page.getByTestId('history-item').last().click()
  await expect(harness.page.getByTestId('history-version')).toContainText('dusk')
  await harness.page.getByTestId('history-compare-tab').click()

  const diff = harness.page.getByTestId('history-diff')
  await expect(diff).toBeVisible()

  // The edited paragraph is one change with the words called out — not a whole
  // paragraph lost and an unrelated one gained.
  await expect(diff.getByTestId('diff-word-removed').first()).toContainText('dusk')
  await expect(diff.getByTestId('diff-word-added').first()).toContainText('dawn')

  // And the paragraph that travelled says so, with both ends of the journey.
  await expect(diff.getByTestId('diff-moved-badge').first()).toContainText('moved from')
})

test('restoring puts the old version back, and keeps the one it replaced', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  const docId = await docIdOf('chapter-01.pubdoc')
  await writeVersion(docId, '2026-08-01T09:00:00.000Z', ['The first draft.'])
  await type('The current draft.')

  await showHistory()
  const before = await versionCount()

  await harness.page.getByTestId('history-item').last().click()
  await expect(harness.page.getByTestId('history-version')).toContainText('The first draft.')
  harness.page.once('dialog', (dialog) => void dialog.accept())
  await harness.page.getByTestId('history-restore').click()

  await waitFor(async () => (await storedText()).includes('The first draft.'), 'the version to be restored')

  // The open document shows the restored text rather than what it had.
  await showEditor('chapter-01.pubdoc')
  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror').first()).toContainText(
    'The first draft.'
  )

  // And the version that was replaced is itself recoverable: a restore is not a
  // one-way door.
  await showHistory()
  expect(await versionCount()).toBeGreaterThan(before)
  await harness.page.getByTestId('history-item').first().click()
  await expect(harness.page.getByTestId('history-version')).toContainText('The current draft.')
})

/*
 * The case a restore must not lose: unsaved work in the editor at the moment it
 * is asked to go back. Nothing on disk knows about it, so a restore that simply
 * wrote over the file would take it with no way back.
 */
test('restoring while there are unsaved edits keeps them as a version of their own', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  const docId = await docIdOf('chapter-01.pubdoc')
  await writeVersion(docId, '2026-08-01T09:00:00.000Z', ['The first draft.'])
  await type('The saved draft.')

  // Typed but never flushed: only the editor knows this exists.
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror').first()
  await editor.click()
  await harness.page.keyboard.press('ControlOrMeta+a')
  await harness.page.keyboard.type('Unsaved and easily lost.')
  await expect(editor).toContainText('Unsaved and easily lost.')

  await showHistory()
  await harness.page.getByTestId('history-item').last().click()
  harness.page.once('dialog', (dialog) => void dialog.accept())
  await harness.page.getByTestId('history-restore').click()

  await waitFor(async () => (await storedText()).includes('The first draft.'), 'the version to be restored')

  // The unsaved paragraph survived, as a version rather than as the document.
  await waitFor(async () => {
    await harness.page.evaluate(() => window.__pub.history.getState().refresh())
    const stamps = await harness.page.evaluate(() =>
      window.__pub.history.getState().snapshots.map((item) => item.timestamp)
    )
    for (const stamp of stamps) {
      const file = path.join(
        harness.projectDir,
        '.thepub',
        'snapshots',
        docId,
        `${stamp.replace(/[:.]/g, '-')}.json`
      )
      const stored = await readJson<PubDocument>(file).catch(() => null)
      if (stored && JSON.stringify(stored.content).includes('Unsaved and easily lost.')) return true
    }
    return false
  }, 'the unsaved edit to be archived')
})

test('a version can be written to a new file, leaving the original alone', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  const docId = await docIdOf('chapter-01.pubdoc')
  await writeVersion(docId, '2026-08-01T09:00:00.000Z', ['The first draft.'])
  await type('The current draft.')

  await showHistory()
  await harness.page.getByTestId('history-item').last().click()
  await harness.page.getByTestId('history-restore-copy').click()

  await expect(harness.page.getByTestId('prompt-dialog')).toBeVisible()
  await harness.page.getByTestId('prompt-input').fill('chapter-01-earlier.pubdoc')
  await harness.page.getByTestId('prompt-confirm').click()

  await waitFor(
    async () => (await storedText('chapter-01-earlier.pubdoc').catch(() => '')).includes('The first draft.'),
    'the copy to be written'
  )

  // The original is untouched by a copy being taken.
  expect(await storedText()).toContain('The current draft.')

  // And the copy is its own document, not a second file claiming the same id —
  // which the index, the binder and every backlink would read as one document.
  expect(await docIdOf('chapter-01-earlier.pubdoc')).not.toBe(docId)
})

test('the panel follows whichever document is in front', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  const first = await docIdOf('chapter-01.pubdoc')
  await writeVersion(first, '2026-08-01T09:00:00.000Z', ['The first chapter.'])

  await showHistory()
  await expect(harness.page.getByTestId('history-item')).toHaveCount(1)

  // A second document, with no history of its own.
  await createDocument(harness.page, 'chapter-02.pubdoc')
  await showHistory()

  // It shows that document's history — which is none — rather than the previous
  // one's versions.
  await expect(harness.page.getByTestId('history-item')).toHaveCount(0)
  await expect(harness.page.getByTestId('history-list')).toContainText('No earlier versions')
})
