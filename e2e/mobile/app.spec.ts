import { test, expect } from '@playwright/test'
import { EDITOR, createDocument, openApp, openDeviceProject } from './helpers.js'

test('starts as the iOS app, not as a desktop window', async ({ page }) => {
  await openApp(page)
  await expect(page.getByTestId('title-bar')).toBeVisible()
  // One full-screen window that the system closes, and nowhere to tear a pane off to.
  await expect(page.getByTestId('window-controls')).toHaveCount(0)
  await expect(page.getByTestId('popout-group')).toHaveCount(0)
  expect(await page.evaluate(async () => (await window.pub.invoke('app:getState', {})).platform)).toBe('ios')

  // Only what a WebView can reach is offered as somewhere to keep a project.
  await page.getByTestId('open-connect').click()
  await expect(page.getByTestId('connect-protocol').locator('option')).toHaveText(['OneDrive'])
})

test('a project made on the device is still there after the app restarts', async ({ page }) => {
  await openApp(page)

  await page.getByRole('button', { name: 'Open a project on this device…' }).click()
  await page.getByTestId('shell-folder-name').fill('Harbour')
  await page.getByTestId('shell-confirm').click()
  await page.waitForFunction(() => window.__pub.project.getState().project !== null)

  await createDocument(page, 'chapter-one.pubdoc')
  const editor = page.locator(EDITOR)
  await editor.click()
  await editor.pressSequentially('The harbour was quiet.')
  await expect(editor).toContainText('The harbour was quiet.')
  await page.evaluate(() => window.__pub.documents.getState().flushAll())

  await page.reload()
  await page.waitForFunction(() => Boolean(window.__pub))
  // Found again by name, in the list the picker draws from the device's storage.
  await page.getByRole('button', { name: 'Open a project on this device…' }).click()
  await page.getByTestId('shell-folder-list').getByRole('button', { name: 'Harbour', exact: true }).click()
  await page.waitForFunction(() => window.__pub.project.getState().project !== null)

  const reopened = await page.evaluate(async () => {
    const id = await window.__pub.documents.getState().openPath('chapter-one.pubdoc')
    const state = window.__pub.documents.getState().docs[id!]!
    window.__pub.layout.getState().openEditor(id!, state.path, state.title)
    return id
  })
  expect(reopened).not.toBeNull()
  await expect(page.locator(EDITOR)).toContainText('The harbour was quiet.')

  // The index is rebuilt from storage too, not from a session that no longer exists.
  await expect
    .poll(() => page.evaluate(async () => (await window.pub.invoke('search:query', { text: 'harbour' })).length))
    .toBeGreaterThan(0)
})

// A 1×1 PNG.
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('an image in a document loads, and the document still names it by its asset URL', async ({ page }) => {
  await openApp(page)
  await openDeviceProject(page, 'Pictures')
  const docId = await createDocument(page, 'plate.pubdoc')

  const url = await page.evaluate(
    async (data) => (await window.pub.invoke('doc:writeAsset', { dataBase64: data, ext: 'png' })).url,
    PIXEL
  )
  expect(url).toMatch(/^pub-asset:\/\//)
  await page.evaluate(
    ([id, src]) => window.__pub.getEditor(id!)!.commands.insertContent({ type: 'image', attrs: { src } }),
    [docId, url]
  )

  const image = page.locator(`${EDITOR} img`)
  // Shown from an object URL, because a WebView has no handler for the scheme…
  await expect(image).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)
  // …while what is saved is untouched, so the desktop app opens the same document.
  const saved = await page.evaluate((id) => JSON.stringify(window.__pub.getEditor(id)!.getJSON()), docId)
  expect(saved).toContain(url)
  expect(saved).not.toContain('blob:')
})

test('Word export goes to the share sheet, and Word import comes from the file picker', async ({ page }) => {
  await openApp(page)
  await openDeviceProject(page, 'Exchange')
  await createDocument(page, 'letter.pubdoc')
  const editor = page.locator(EDITOR)
  await editor.click()
  await editor.pressSequentially('Sent by the evening post.')
  await expect(editor).toContainText('Sent by the evening post.')
  await page.evaluate(() => window.__pub.documents.getState().flushAll())

  const downloading = page.waitForEvent('download')
  await page.evaluate(() => window.pub.invoke('docx:exportDialog', { paths: ['letter.pubdoc'] }))
  const download = await downloading
  expect(download.suggestedFilename()).toBe('letter.docx')
  const exported = await download.path()

  const choosing = page.waitForEvent('filechooser')
  const importing = page.evaluate(() => window.pub.invoke('docx:importDialog', { targetDir: 'imported' }))
  await (await choosing).setFiles(exported)
  const result = await importing
  expect(result?.imported).toHaveLength(1)

  const text = await page.evaluate(
    async (path) => JSON.stringify((await window.pub.invoke('doc:read', { path })).doc.content),
    result!.imported[0]!.path
  )
  expect(text).toContain('Sent by the evening post.')
})

test('leaving the app saves what autosave had not got to yet', async ({ page }) => {
  await openApp(page)
  await openDeviceProject(page, 'Interrupted')
  // Autosave pushed out of reach, so only the suspend can be what writes the file.
  await page.evaluate(() =>
    window.__pub.project.getState().updateManifest((manifest) => ({
      ...manifest,
      settings: { ...manifest.settings, autosaveDebounceMs: 30_000, autosaveMaxWaitMs: 30_000 }
    }))
  )
  await createDocument(page, 'mid-sentence.pubdoc')
  const editor = page.locator(EDITOR)
  await editor.click()
  await editor.pressSequentially('The phone rang before the sentence was')
  await expect(editor).toContainText('before the sentence was')

  const onDisk = (): Promise<string> =>
    page.evaluate(async () =>
      JSON.stringify((await window.pub.invoke('doc:read', { path: 'mid-sentence.pubdoc' })).doc.content)
    )
  expect(await onDisk()).not.toContain('The phone rang')

  // What iOS does when the home indicator is swiped: the page is hidden, and may never be shown again.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(onDisk).toContain('The phone rang before the sentence was')
})
