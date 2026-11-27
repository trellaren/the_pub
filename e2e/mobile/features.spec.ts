import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EDITOR, createDocument, openApp, openDeviceProject } from './helpers.js'

/*
 * Features that lean on something the iOS build replaces: a worker under the
 * page's content-security-policy, an offscreen window, a native dialog. The
 * desktop suite covers what each does; these cover that it still does it here.
 */

test('an attached PDF opens in the reader', async ({ page }) => {
  await openApp(page)
  await openDeviceProject(page, 'Research')
  await createDocument(page, 'chapter-01.pubdoc')

  const bytes = Array.from(await fs.readFile(path.resolve(import.meta.dirname, '../fixtures/sample.pdf')))
  await page.evaluate(async (raw) => {
    const source = await window.__pub.sources.getState().create('article-journal')
    window.__pub.sources.getState().patch(source!.id, { title: 'A Fixture Paper' })
    await window.__pub.sources.getState().flush()
    await window.__pub.research.getState().addPdf(source!.id, new Uint8Array(raw).buffer, 'sample.pdf')
  }, bytes)

  await page.evaluate(() => window.__pub.runCommand('panel.research'))
  await page.getByRole('button', { name: 'Sources', exact: true }).click()
  await page.getByRole('button', { name: 'Open sample.pdf' }).click()
  await expect(page.getByText('Page 1 of 1')).toBeVisible()
})

test('Print lays the manuscript out and hands it to the system print sheet', async ({ page }) => {
  // The sheet itself is the system's; what is ours is that it is asked, with the right pages.
  await page.addInitScript(() => {
    window.print = () => {
      ;(window.top as unknown as { printed: string[] }).printed = [document.body.innerText]
    }
  })
  await openApp(page)
  await openDeviceProject(page, 'Printing')
  await createDocument(page, 'letter.pubdoc')
  const editor = page.locator(EDITOR)
  await editor.click()
  await editor.pressSequentially('Set in type at last.')
  await expect(editor).toContainText('Set in type at last.')
  await page.evaluate(() => window.__pub.documents.getState().flushAll())

  await page.evaluate(() => window.pub.invoke('publish:exportDialog', { format: 'print', paths: ['letter.pubdoc'] }))
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { printed?: string[] }).printed?.[0] ?? ''))
    .toContain('Set in type at last.')
})

test('a context menu opens for a mouse as it does on desktop, and offers nothing a device lacks', async ({ page }) => {
  await openApp(page)
  await openDeviceProject(page, 'Menus')
  await createDocument(page, 'one.pubdoc')

  await page.getByRole('treeitem', { name: /one/ }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
  // No file manager to reveal it in, and no trash to move it to.
  await expect(page.getByRole('menuitem', { name: 'Reveal in File Manager' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Move to Trash' })).toHaveCount(0)
})

test('a project deleted from the device is gone from the picker and from Recent', async ({ page }) => {
  await openApp(page)
  await openDeviceProject(page, 'Abandoned')
  await page.evaluate(() => window.pub.invoke('project:close', {}))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.__pub))
  await expect(page.getByTestId('recent-project')).toHaveCount(1)

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Open a project on this device…' }).click()
  await page.getByRole('button', { name: 'Delete Abandoned from this device' }).click()
  await expect(page.getByTestId('shell-folder-list')).toContainText('No projects are stored on this device yet.')
  await page.getByTestId('shell-cancel').click()
  await expect(page.getByTestId('recent-project')).toHaveCount(0)
})
