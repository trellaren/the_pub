import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import FtpSrv from 'ftp-srv'
import { launch, cleanup, waitFor, type Harness } from './helpers.js'
import type { PubDocument } from '../src/shared/model/document.js'

let harness: Harness
let server: FtpSrv | null = null
let serverRoot = ''
let port = 0

/**
 * A real FTP server, serving a real directory.
 *
 * The remote adapters are almost entirely protocol handling, so a fake would
 * test the fake. This exercises the actual path: the app opens a project over
 * FTP, scaffolds `.thepub` on the server, writes a document, and reads it back
 * — and the files that appear in the served directory are the proof.
 */
async function startFtp(): Promise<void> {
  serverRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-ftp-'))
  // Port 0 would be ideal, but the server needs to know its own URL for passive
  // mode, so a fixed high port with a retry is simpler and just as reliable.
  port = 30_000 + Math.floor(process.pid % 20_000)
  server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: '127.0.0.1',
    anonymous: true
  })
  server.on('login', (_data, resolve) => resolve({ root: serverRoot }))
  await server.listen()
}

test.beforeAll(startFtp)

test.afterAll(async () => {
  await server?.close()
  server = null
  await fs.rm(serverRoot, { recursive: true, force: true }).catch(() => {})
})

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

/**
 * Save the server as a profile and return the project URI for it.
 *
 * Each test gets its own folder on the server, which keeps them independent and
 * exercises the profile's remote path at the same time.
 */
async function saveProfile(remotePath = '/'): Promise<string> {
  if (remotePath !== '/') await fs.mkdir(path.join(serverRoot, remotePath), { recursive: true })
  return harness.page.evaluate(
    async ({ port: ftpPort, remotePath: root }) => {
      const profile = await window.pub.invoke('connections:save', {
        profile: {
          name: 'Test server',
          protocol: 'ftp',
          host: '127.0.0.1',
          port: ftpPort,
          user: 'anonymous',
          remotePath: root,
          secure: false
        },
        secret: 'anonymous@'
      })
      return `ftp://${(profile as { id: string }).id}`
    },
    { port, remotePath }
  )
}

test('a saved server can be tested before a project is opened on it', async () => {
  harness = await launch()
  const uri = await saveProfile()
  const id = uri.split('//')[1]!

  const result = await harness.page.evaluate(
    (profileId) => window.pub.invoke('connections:test', { id: profileId }),
    id
  )
  // A typo otherwise surfaces as a project that opens empty, which reads like
  // data loss rather than a mistake.
  expect(result).toMatchObject({ ok: true })
})

test('a project opens over FTP and scaffolds itself on the server', async () => {
  harness = await launch()
  const uri = await saveProfile('scaffold')

  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await harness.page.waitForFunction(() => window.__pub.project.getState().project !== null)

  await waitFor(async () => {
    const files: string[] = await fs
      .readdir(path.join(serverRoot, 'scaffold', '.thepub'))
      .catch(() => [] as string[])
    return files.includes('project.json')
  }, 'the manifest to be written to the server')

  const manifest = JSON.parse(
    await fs.readFile(path.join(serverRoot, 'scaffold', '.thepub', 'project.json'), 'utf8')
  ) as { styles: { id: string }[] }
  expect(manifest.styles.some((style) => style.id === 'body')).toBe(true)
})

test('a document written over FTP lands on the server and reads back', async () => {
  harness = await launch()
  const uri = await saveProfile('writes')
  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await harness.page.waitForFunction(() => window.__pub.project.getState().project !== null)

  const docId = await harness.page.evaluate(async () => {
    const id = await window.__pub.documents.getState().create('chapter-01.pubdoc')
    if (!id) return null
    // Read the store again after the await: the snapshot taken before it does
    // not have the document that was just created.
    const state = window.__pub.documents.getState().docs[id]!
    window.__pub.layout.getState().openEditor(id, state.path, state.title)
    return id
  })
  expect(docId).toBeTruthy()

  const editor = harness.page.locator('.pub-sheet .ProseMirror')
  await expect(editor).toBeVisible()
  await editor.click()
  await harness.page.keyboard.type('Written straight to the server.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  const file = path.join(serverRoot, 'writes', 'chapter-01.pubdoc')
  await waitFor(async () => {
    const raw = await fs.readFile(file, 'utf8').catch(() => '')
    return raw.includes('Written straight to the server')
  }, 'the document to reach the server')

  // Atomic writes leave no temporary file behind on a remote backend either.
  const listing = await fs.readdir(path.join(serverRoot, 'writes'))
  expect(listing.filter((name) => name.includes('.tmp-'))).toEqual([])

  const saved = JSON.parse(await fs.readFile(file, 'utf8')) as PubDocument
  expect(saved.docId).toBeTruthy()
  expect(saved.wordCount).toBeGreaterThan(0)
})

test('search indexes a project served over FTP', async () => {
  harness = await launch()
  const uri = await saveProfile('indexing')
  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await harness.page.waitForFunction(() => window.__pub.project.getState().project !== null)

  await harness.page.evaluate(async () => {
    const id = await window.__pub.documents.getState().create('chapter-01.pubdoc')
    const state = window.__pub.documents.getState().docs[id!]!
    window.__pub.layout.getState().openEditor(id!, state.path, state.title)
  })
  const editor = harness.page.locator('.pub-sheet .ProseMirror')
  await editor.click()
  await harness.page.keyboard.type('The lighthouse keeper counted the days.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  await waitFor(async () => {
    const hits = await harness.page.evaluate(() =>
      window.pub.invoke('search:query', {
        text: 'lighthouse',
        limit: 20,
        matchCase: false,
        wholeWord: false
      })
    )
    return (hits as unknown[]).length > 0
  }, 'the remote document to be indexed')
})

test('opening a project on a server that is gone fails with something readable', async () => {
  harness = await launch()
  const error = await harness.page.evaluate(async () => {
    try {
      await window.pub.invoke('project:open', { uri: 'ftp://not-a-real-profile' })
      return null
    } catch (thrown) {
      return String(thrown)
    }
  })
  expect(error).toContain('no longer exists')
})
