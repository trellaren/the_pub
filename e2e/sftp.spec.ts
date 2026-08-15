import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { launch, cleanup, waitFor, type Harness } from './helpers.js'
import { startSftpServer, type TestServer } from '../src/main/vfs/sftpTestServer.js'
import { TINY_PNG_BASE64, tinyPngBytes, loadImage, TINY_PNG_WIDTH, TINY_PNG_HEIGHT } from './images.js'
import type { PubDocument } from '../src/shared/model/document.js'

/**
 * The whole app over SFTP, against a real SSH server.
 *
 * The mirror of `remote.spec.ts`, which does the same for FTP — deliberately
 * the same shape, so the two backends are proven the same way rather than one
 * being trusted because the other was tested.
 *
 * The server is `ssh2.Server`, the server half of the library the app already
 * uses as a client, so this exercises the code that ships. That matters more
 * since packaging: the release excludes ssh2's optional native bindings and
 * runs SSH crypto in pure JavaScript, and this is the suite that would notice
 * if that stopped working.
 */

let harness: Harness
let server: TestServer | null = null
let serverRoot = ''
let keyPath = ''

test.beforeAll(async () => {
  serverRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-sftp-e2e-'))
  server = await startSftpServer(serverRoot)
  // The app reads the key from a path on this machine, so it has to be a real
  // file — outside the served directory, which is the project root.
  keyPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pub-sftp-key-')), 'id_rsa')
  await fs.writeFile(keyPath, server.clientKey, { mode: 0o600 })
})

test.afterAll(async () => {
  await server?.close()
  server = null
  await fs.rm(serverRoot, { recursive: true, force: true }).catch(() => {})
  await fs.rm(path.dirname(keyPath), { recursive: true, force: true }).catch(() => {})
})

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

/**
 * Save the server as a profile and return the project URI for it.
 *
 * Key authentication rather than a password, and not by preference:
 * `ConnectionStore.save` drops the secret when `safeStorage.isEncryptionAvailable()`
 * is false, which is exactly the case on the headless Linux this suite runs on.
 * A password profile would reach the adapter as an empty string, so the test
 * would prove only that the server accepts empty passwords. An unencrypted key
 * sidesteps that — a passphrase would be dropped for the same reason — and it
 * covers `profile.auth === 'key'`, `ConnectionResolver.privateKey` and the
 * `privateKeyPath` read, none of which any other test touches. Password auth is
 * covered in `sftpAdapter.test.ts`, which builds the adapter directly and never
 * goes near the store.
 */
async function saveProfile(remotePath = '/', privateKeyPath = keyPath): Promise<string> {
  if (remotePath !== '/') await fs.mkdir(path.join(serverRoot, remotePath), { recursive: true })
  return harness.page.evaluate(
    async ({ port, remotePath: root, privateKeyPath: key }) => {
      const profile = await window.pub.invoke('connections:save', {
        profile: {
          name: 'Test server',
          protocol: 'sftp',
          host: '127.0.0.1',
          port,
          user: 'author',
          auth: 'key',
          privateKeyPath: key,
          remotePath: root,
          secure: false
        },
        secret: ''
      })
      return `sftp://${(profile as { id: string }).id}`
    },
    { port: server!.port, remotePath, privateKeyPath }
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
  expect(result).toMatchObject({ ok: true })
})

test('a project opens over SFTP and scaffolds itself on the server', async () => {
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

test('a document written over SFTP lands on the server and reads back', async () => {
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
  await harness.page.keyboard.type('Written straight to the server over SSH.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  const file = path.join(serverRoot, 'writes', 'chapter-01.pubdoc')
  await waitFor(async () => {
    const raw = await fs.readFile(file, 'utf8').catch(() => '')
    return raw.includes('Written straight to the server')
  }, 'the document to reach the server')

  // Save a second time, which is the interesting one. The first save has no
  // file to replace; the second renames over one that exists, and SFTP refuses
  // that outright — so this is the save that goes through the move-aside path
  // in `RemoteAdapter`, the code that keeps the previous draft safe while the
  // new one lands.
  await editor.click()
  await harness.page.keyboard.type(' A second pass over the same chapter.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
  await waitFor(async () => {
    const raw = await fs.readFile(file, 'utf8').catch(() => '')
    return raw.includes('A second pass')
  }, 'the second save to reach the server')

  const listing = await fs.readdir(path.join(serverRoot, 'writes'))
  // No temporary sibling, as on every backend — and no `.old-` either. The
  // move-aside path leaves the previous version beside the manuscript under a
  // `.old-` name while the replacement lands, and a bug there would strand it:
  // the author would find two copies of a chapter with no way to tell which
  // one is theirs.
  expect(listing.filter((name) => name.includes('.tmp-'))).toEqual([])
  expect(listing.filter((name) => name.includes('.old-'))).toEqual([])

  const saved = JSON.parse(await fs.readFile(file, 'utf8')) as PubDocument
  expect(saved.docId).toBeTruthy()
  expect(saved.wordCount).toBeGreaterThan(0)
})

test('search indexes a project served over SFTP', async () => {
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
  await harness.page.keyboard.type('The harbourmaster kept a ledger of every tide.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  await waitFor(async () => {
    const hits = await harness.page.evaluate(() =>
      window.pub.invoke('search:query', {
        text: 'harbourmaster',
        limit: 20,
        matchCase: false,
        wholeWord: false
      })
    )
    return (hits as unknown[]).length > 0
  }, 'the remote document to be indexed')
})

/**
 * A key path that points nowhere.
 *
 * The failure has to name the key, because everything else about the profile is
 * correct and the author has no other way to tell this apart from the server
 * being down. This used to escape the handler and surface in the dialog as
 * "Could not reach the server." — an answer that sends someone to check their
 * network when the problem is a path they can see.
 */
test('a profile whose private key is missing says so', async () => {
  harness = await launch()
  const uri = await saveProfile('/', path.join(os.tmpdir(), 'pub-no-such-key-anywhere'))
  const id = uri.split('//')[1]!

  const result = (await harness.page.evaluate(
    (profileId) => window.pub.invoke('connections:test', { id: profileId }),
    id
  )) as { ok: boolean; message: string }

  expect(result.ok).toBe(false)
  expect(result.message).toContain('Could not read the private key at')
  expect(result.message).toContain('pub-no-such-key-anywhere')
})

test('opening a project on a server that is gone fails with something readable', async () => {
  harness = await launch()
  const error = await harness.page.evaluate(async () => {
    try {
      await window.pub.invoke('project:open', { uri: 'sftp://not-a-real-profile' })
      return null
    } catch (thrown) {
      return String(thrown)
    }
  })
  expect(error).toContain('no longer exists')
})

/*
 * An image stored on a server, served back to the renderer.
 *
 * This is the only test that exercises the asset protocol's adapter branch.
 * Before it, `pub-asset://` resolved every request against the local
 * filesystem, so a project on a server showed a broken image and nothing said
 * why — and no unit test can stand in for this, because the whole question is
 * whether the protocol handler, the session lookup and a real SFTP read line
 * up end to end.
 */
test('an image written to a project on the server is served back to the renderer', async () => {
  harness = await launch()
  const uri = await saveProfile('images')
  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await harness.page.waitForFunction(() => window.__pub.project.getState().project !== null)

  const asset = (await harness.page.evaluate(
    (dataBase64) => window.pub.invoke('doc:writeAsset', { dataBase64, ext: 'png' }),
    TINY_PNG_BASE64
  )) as { path: string; url: string }

  // The bytes really are on the server, not somewhere local.
  expect(asset.path).toMatch(/^assets\//)
  const onServer = await fs.readFile(path.join(serverRoot, 'images', asset.path))
  expect(onServer.equals(tinyPngBytes())).toBe(true)

  // And the renderer can display them: decoding proves the handler returned
  // the real bytes, not a 404 page.
  expect(asset.url).toMatch(/^pub-asset:\/\//)
  expect(await loadImage(harness.page, asset.url)).toEqual({
    ok: true,
    width: TINY_PNG_WIDTH,
    height: TINY_PNG_HEIGHT
  })
})

test('an asset url stops resolving once its project is closed', async () => {
  harness = await launch()
  const uri = await saveProfile('closing')
  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await harness.page.waitForFunction(() => window.__pub.project.getState().project !== null)

  const asset = (await harness.page.evaluate(
    (dataBase64) => window.pub.invoke('doc:writeAsset', { dataBase64, ext: 'png' }),
    TINY_PNG_BASE64
  )) as { path: string; url: string }

  // Deliberately not loaded while the project is open: Chromium keeps decoded
  // images in memory, so a url fetched once would still resolve from cache and
  // the assertion below would pass without the handler being consulted at all.
  await harness.page.evaluate(() => window.pub.invoke('project:close', {}))

  // The token names a project, and an unopen project has nothing to authorise
  // a read against — which is what keeps a hand-edited src from reaching one.
  expect((await loadImage(harness.page, asset.url)).ok).toBe(false)
})
