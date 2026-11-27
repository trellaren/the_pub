import { test, expect, type Page } from '@playwright/test'
import { ACCOUNT, EDITOR, createDocument, desktopAdapter, openApp, serveOneDrive } from './helpers.js'
import { DocumentService } from '../../src/main/services/documentService.js'
import { SnapshotService } from '../../src/main/services/snapshotService.js'
import { DELTA_POLL_INTERVAL_MS } from '../../src/main/vfs/oneDriveAdapter.js'
import type { FakeDrive } from '../../src/main/onedrive/fakeDrive.js'

const FOLDER = 'Documents/Novel'

/** Sign in and open the project folder, the way a person does it: through the dialog and Microsoft's page. */
async function connect(page: Page): Promise<void> {
  await page.getByTestId('open-connect').click()
  await page.getByTestId('connect-client-id').fill('11111111-2222-3333-4444-555555555555')
  await page.getByTestId('connect-path').fill(FOLDER)
  await page.getByTestId('connect-signin').click()
  await expect(page.getByTestId('connect-account')).toContainText(`Signed in as ${ACCOUNT}`)
  await page.getByTestId('connect-open').click()
  await page.waitForFunction(() => window.__pub.project.getState().project !== null)
}

/** The desktop app's document service on the same drive — the Windows side of the sync. */
function desktop(drive: FakeDrive): DocumentService {
  const adapter = desktopAdapter(drive, FOLDER)
  return new DocumentService(adapter, new SnapshotService(adapter))
}

test('signing in keeps the token out of the page, and the sign-in survives a restart', async ({ page, context }) => {
  await serveOneDrive(context, FOLDER)
  await openApp(page)
  await connect(page)

  const listed = await page.evaluate(() => window.pub.invoke('connections:list', {}))
  expect(listed.connections).toHaveLength(1)
  expect(listed.connections[0]!.hasSecret).toBe(true)
  expect(JSON.stringify(listed)).not.toContain('refresh-0')
  // Nor is it readable where the page could find it: what is stored is sealed.
  const stored = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('quoth-files')
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error)
    })
    const all = await new Promise<Uint8Array[]>((resolve, reject) => {
      const reading = database.transaction('data').objectStore('data').getAll()
      reading.onsuccess = () => resolve(reading.result as Uint8Array[])
      reading.onerror = () => reject(reading.error)
    })
    return all.map((bytes) => new TextDecoder().decode(bytes)).join('\n')
  })
  expect(stored).toContain('onedrive')
  expect(stored).not.toContain('refresh-0')

  await page.reload()
  await page.waitForFunction(() => Boolean(window.__pub))
  await page.getByTestId('recent-project').first().getByRole('button').first().click()
  await page.waitForFunction(() => window.__pub.project.getState().project !== null)
})

test('what is written on iOS is what the desktop app reads from the same OneDrive folder', async ({
  page,
  context
}) => {
  const drive = await serveOneDrive(context, FOLDER)
  await openApp(page)
  await connect(page)

  await createDocument(page, 'chapter-one.pubdoc')
  const editor = page.locator(EDITOR)
  await editor.click()
  await editor.pressSequentially('Written on the train.')
  await expect(editor).toContainText('Written on the train.')
  await page.evaluate(() => window.__pub.documents.getState().flushAll())

  expect([...drive.files.keys()]).toContain(`${FOLDER}/chapter-one.pubdoc`)
  expect([...drive.files.keys()]).toContain(`${FOLDER}/.thepub/project.json`)
  const onDesktop = await desktop(drive).read('chapter-one.pubdoc')
  expect(JSON.stringify(onDesktop.doc.content)).toContain('Written on the train.')
})

test('what the desktop app writes turns up on iOS without reopening the project', async ({ page, context }) => {
  test.setTimeout(90_000)
  const drive = await serveOneDrive(context, FOLDER)
  await openApp(page)
  await connect(page)

  // Let the pass that indexes a project on open finish first, so that what
  // follows can only have arrived by way of the drive's change feed.
  await expect
    .poll(() => page.evaluate(async () => (await window.pub.invoke('search:status', {})).indexing))
    .toBe(false)
  await page.waitForTimeout(500)

  const services = desktop(drive)
  const created = await services.create('written-at-the-desk.pubdoc', 'Written at the desk')
  await services.write(
    'written-at-the-desk.pubdoc',
    {
      ...created.doc,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From the desktop.' }] }] }
    },
    created.mtime
  )
  // OneDrive reports another device's write on its change feed; the fake drive is told by hand.
  drive.delta.push(drive.item(`${FOLDER}/written-at-the-desk.pubdoc`))

  await expect(page.getByRole('treeitem', { name: /written-at-the-desk/ })).toBeVisible({
    timeout: DELTA_POLL_INTERVAL_MS * 2
  })
  // And it is searchable there: the watcher indexed it as it arrived.
  await expect
    .poll(() => page.evaluate(async () => (await window.pub.invoke('search:query', { text: 'desktop' })).length))
    .toBeGreaterThan(0)
})

test('a document changed on the desktop is not overwritten by a stale copy on iOS', async ({ page, context }) => {
  const drive = await serveOneDrive(context, FOLDER)
  await openApp(page)
  await connect(page)

  const docId = await createDocument(page, 'shared.pubdoc')
  const editor = page.locator(EDITOR)
  await editor.click()
  await editor.pressSequentially('First draft.')
  await expect(editor).toContainText('First draft.')
  await page.evaluate(() => window.__pub.documents.getState().flushAll())

  // The desktop saves over it while iOS still holds the version it loaded.
  const services = desktop(drive)
  const loaded = await services.read('shared.pubdoc')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const saved = await services.write(
    'shared.pubdoc',
    {
      ...loaded.doc,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Desk revision.' }] }] }
    },
    loaded.mtime
  )
  expect(saved.ok).toBe(true)

  await editor.click()
  await editor.pressSequentially(' More from the train.')
  await page.evaluate(() => window.__pub.documents.getState().flushAll())

  await expect(page.getByText('This file changed outside Quoth.')).toBeVisible()
  const onDrive = drive.files.get(`${FOLDER}/shared.pubdoc`)!.toString('utf8')
  expect(onDrive).toContain('Desk revision.')
  expect(onDrive).not.toContain('More from the train.')
  expect(docId).toBeTruthy()
})
