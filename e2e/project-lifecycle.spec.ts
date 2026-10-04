import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, type Harness } from './helpers.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

test('a failed open leaves the current project open and still saving', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const notAFolder = path.join(harness.userDataDir, 'not-a-folder.txt')
  await fs.writeFile(notAFolder, 'plain text')

  const opened = await harness.page.evaluate(
    (uri) => window.__pub.project.getState().open(uri),
    notAFolder
  )
  expect(opened).toBeNull()
  const notice = harness.page.getByTestId('notice-error')
  await expect(notice).toBeVisible()
  await expect(notice).not.toContainText('Error invoking remote method')
  await expect(harness.page.getByRole('alert').filter({ hasText: 'Could not open project' })).toHaveCount(1)
  await notice.getByTestId('notice-dismiss').click()
  await expect(notice).toHaveCount(0)
  expect(await harness.page.evaluate(() => window.__pub.project.getState().project?.uri)).toBe(
    harness.projectDir
  )

  const docId = await createDocument(harness.page, 'after-failure.pubdoc')
  expect(docId).toBeTruthy()
  await expect.poll(() => fs.stat(path.join(harness.projectDir, 'after-failure.pubdoc')).then(() => true, () => false)).toBe(true)
})

test('Close Project returns to Welcome and the project reopens intact', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'kept.pubdoc')

  await harness.page.getByTestId('menu-file').click()
  await harness.page.getByTestId('menu-item-project.close').click()

  await expect.poll(() => harness.page.evaluate(() => window.__pub.project.getState().project)).toBeNull()
  await expect(harness.page.getByTestId('open-new-project')).toBeVisible()
  expect(await harness.page.evaluate(() => Object.keys(window.__pub.documents.getState().docs))).toEqual([])
  expect(await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())).toBe('Quoth')

  await openProject(harness.page, harness.projectDir)
  await expect(harness.page.getByText('kept', { exact: false }).first()).toBeVisible()
})
