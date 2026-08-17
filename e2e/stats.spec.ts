import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { StatsFile } from '../src/shared/model/stats.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

async function editor() {
  const locator = harness.page.locator('.pub-sheet:visible .ProseMirror').first()
  await expect(locator).toBeVisible()
  return locator
}

/** The one stats file a fresh project's local author writes to. */
async function statsFiles(): Promise<string[]> {
  const dir = path.join(harness.projectDir, '.thepub', 'stats')
  const fs = await import('node:fs/promises')
  return (await fs.readdir(dir).catch(() => [])).map((name) => path.join(dir, name))
}

test('typing persists today’s word count and the Progress panel shows it after a reopen', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  await (await editor()).click()
  await harness.page.keyboard.type('The quick brown fox jumps over the lazy dog.')
  await expect(await editor()).toContainText('jumps over the lazy dog')

  // Wait for the autosave debounce, which is what triggers the stats record.
  await waitFor(async () => {
    const dirty = await harness.page.evaluate(() => {
      const state = window.__pub.documents.getState()
      const doc = state.docs[state.activeDocId!]
      return doc?.dirty ?? true
    })
    return dirty === false
  }, 'the document to autosave')

  await waitFor(async () => {
    const days = await harness.page.evaluate(() => window.__pub.stats.getState().days)
    return days.some((day) => day.added > 0)
  }, 'today’s word count to be recorded')

  // Force a flush rather than waiting out the multi-second stats debounce.
  await harness.page.evaluate(() => window.__pub.stats.getState().flush())
  await waitFor(async () => (await statsFiles()).length > 0, 'a stats file to be written')

  const [file] = await statsFiles()
  const stored = await readJson<StatsFile>(file!)
  expect(stored.days.length).toBeGreaterThan(0)
  expect(stored.days[0]!.added).toBeGreaterThan(0)

  const { projectDir, userDataDir } = harness
  await harness.app.close()

  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)

  await waitFor(async () => {
    const days = await harness.page.evaluate(() => window.__pub.stats.getState().days)
    return days.some((day) => day.added > 0)
  }, 'stats to reload after reopening the project')

  await harness.page.evaluate(() => window.__pub.runCommand('panel.progress'))
  await expect(harness.page.getByText('Today').first()).toBeVisible()
  await expect(harness.page.getByText(/words/).first()).toBeVisible()
})
