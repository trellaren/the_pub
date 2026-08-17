import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

async function editor() {
  const locator = harness.page.locator('.pub-sheet:visible .ProseMirror').first()
  await expect(locator).toBeVisible()
  return locator
}

/**
 * Resolves an earlier open question left by two prior passes: does opening a
 * dock panel right after a project reopen (with a document already restored
 * from the saved layout) crash the renderer? Both prior investigations were
 * inconclusive because their test closed the app before the layout with the
 * active document had actually persisted, so on reopen no document was ever
 * restored — meaning neither test could tell "the panel crashed" apart from
 * "there was nothing for the panel to render yet". This test waits for
 * `layout.lastLayout !== null` before closing, exactly as
 * `highlights.spec.ts`'s reopen test does, so the reopen genuinely restores
 * an active document before either panel opens.
 */
test('the Research and Notes panels open without crashing after a project reopen with an active document', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  await (await editor()).click()
  await harness.page.keyboard.type('The quick brown fox jumps.')
  await expect(await editor()).toContainText('The quick brown fox jumps.')

  const layoutFile = path.join(harness.projectDir, '.thepub', 'layouts.json')
  await waitFor(async () => {
    const layout = await readJson<{ lastLayout: unknown }>(layoutFile)
    return layout.lastLayout !== null
  }, 'the layout to be persisted')

  const { projectDir, userDataDir } = harness
  await harness.app.close()

  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)

  await waitFor(async () => {
    const activeDocId = await harness.page.evaluate(() => window.__pub.documents.getState().activeDocId)
    return activeDocId === docId
  }, 'the reopened document to become active')

  // Open the Research panel first, and confirm the app is still alive by
  // exercising the live editor through further activity rather than merely
  // checking the panel rendered once.
  await harness.page.evaluate(() => window.__pub.runCommand('panel.research'))
  await expect(harness.page.getByText('No highlights yet')).toBeVisible()
  await (await editor()).click()
  await harness.page.keyboard.press('End')
  await harness.page.keyboard.type(' Still alive.')
  await expect(await editor()).toContainText('Still alive.')

  // Now the Notes panel, on the same reopened session.
  await harness.page.evaluate(() => window.__pub.runCommand('panel.notes'))
  await expect(harness.page.getByText(/no notes/i)).toBeVisible()
  await (await editor()).click()
  await harness.page.keyboard.press('End')
  await harness.page.keyboard.type(' And still.')
  await expect(await editor()).toContainText('And still.')
})
