import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { unzipSync, strFromU8 } from 'fflate'
import asar from '@electron/asar'
import { launch, packagedExecutable, cleanup, createDocument, openProject, waitFor, type Harness } from './helpers.js'

/**
 * The app as it is actually installed, rather than as it is developed.
 *
 * The rest of the end-to-end suite already runs the production paths — because
 * `launch()` sets no `ELECTRON_RENDERER_URL`, the loopback renderer server and
 * the strict content-security-policy are exercised by every spec. What none of
 * them touch is the packaging itself: the asar archive, the pruned production
 * `node_modules` inside it, and the real executable's own profile directory.
 *
 * So this file deliberately tests only that delta. Anything already covered
 * against `out/` is not repeated here, because a second launch of a slower
 * binary to re-prove a known-good thing is time nobody gets back.
 */

let harness: Harness
let executablePath = ''
let scratch = ''

test.beforeAll(async () => {
  const found = await packagedExecutable()
  // A throw rather than a skip: the only way this file runs at all is someone
  // naming the packaged config, and a silent pass would be a lie.
  if (!found) throw new Error('No packaged build in release/. Run `npm run package` first.')
  executablePath = found
})

test.beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-e2e-packaged-'))
})

test.afterEach(async () => {
  if (harness) await cleanup(harness)
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
})

test('the app runs from its own binary, with the renderer left unpacked', async () => {
  harness = await launch({ executablePath })

  const paths = await harness.app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    userData: app.getPath('userData')
  }))

  expect(paths.packaged).toBe(true)
  expect(path.basename(paths.appPath)).toBe('app.asar')
  // The renderer came over loopback, not file:// — which is what makes the
  // `'self'` content-security-policy mean anything and lets popouts share a
  // JS context with their opener.
  expect(harness.page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
  // realpath on both sides: macOS reports /private/var where os.tmpdir() says
  // /var, and a bare comparison fails there and nowhere else.
  expect(await fs.realpath(paths.userData)).toBe(await fs.realpath(harness.userDataDir))

  /*
   * Read the archive's own header, not the app's behaviour.
   *
   * Electron's asar shim serves `stat` and `createReadStream` transparently
   * from inside the archive, and the renderer server uses exactly those two
   * calls — so deleting the `asarUnpack` rule would change nothing observable
   * and every other test would still pass. This is the only assertion that
   * would notice.
   */
  const entry = asar.statFile(paths.appPath, 'out/renderer/index.html') as { unpacked?: boolean }
  expect(entry.unpacked).toBe(true)
})

test('prose written in the packaged app reaches disk and comes back out as .docx', async () => {
  /*
   * The most valuable functional test here, because `docx`, `fflate` and
   * `fast-xml-parser` are deliberately kept out of the main bundle and resolved
   * by name from `app.asar/node_modules` at runtime. If the packaging config
   * ever stopped shipping them, this is the only thing in the repo that fails —
   * and it fails only in a packaged build.
   */
  harness = await launch({ executablePath })
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await expect(editor).toBeVisible()
  await editor.click()
  await harness.page.keyboard.type('The lighthouse keeper counted the days.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  // The app writes to a real project folder while running from a read-only
  // archive — the two halves that only meet in a packaged build.
  await waitFor(async () => {
    const raw = await fs.readFile(path.join(harness.projectDir, 'chapter-01.pubdoc'), 'utf8').catch(() => '')
    return raw.includes('The lighthouse keeper counted the days.')
  }, 'the document to reach disk')

  const target = path.join(scratch, 'chapter.docx')
  const exported = await harness.page.evaluate(
    (file) => window.pub.invoke('docx:export', { paths: ['chapter-01.pubdoc'], file }),
    target
  )
  expect(exported).toMatchObject({ ok: true })

  const xml = strFromU8(unzipSync(new Uint8Array(await fs.readFile(target)))['word/document.xml']!)
  expect(xml).toContain('The lighthouse keeper counted the days.')

  // Import exercises fflate and fast-xml-parser, which export does not.
  const imported = await harness.page.evaluate(
    (file) => window.pub.invoke('docx:import', { files: [file], targetDir: '' }),
    target
  )
  expect(imported.imported).toHaveLength(1)

  // And the search index proves node:sqlite opened a database under the real
  // profile directory rather than a development one.
  await waitFor(async () => {
    const hits = await harness.page.evaluate(() =>
      window.pub.invoke('search:query', { text: 'lighthouse', limit: 20, matchCase: false, wholeWord: false })
    )
    return hits.length > 0
  }, 'the packaged app to index its project')
})

test('a saved server is stored under the real profile, with ssh2 packed alongside', async () => {
  harness = await launch({ executablePath })

  const saved = await harness.page.evaluate(() =>
    window.pub.invoke('connections:save', {
      profile: {
        name: 'Box',
        protocol: 'sftp' as const,
        host: '127.0.0.1',
        // Port 1 is not listening, so this fails fast at connect.
        port: 1,
        user: 'nobody'
      },
      secret: 'hunter2'
    })
  )

  const result = await harness.page.evaluate(
    (id) => window.pub.invoke('connections:test', { id }),
    saved.id
  )
  // Getting as far as a refused connection is the assertion: it proves `ssh2`
  // resolved and built a client from inside the archive. A missing module would
  // fail with a resolution error instead.
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/ECONNREFUSED|connect|refused|timed out/i)

  const file = path.join(harness.userDataDir, 'connections.json')
  expect(await fs.readFile(file, 'utf8')).toContain('Box')

  // Only assert encryption where there is a keychain to do it: headless Linux
  // under xvfb has none, and the store has a documented branch for that.
  const encrypting = await harness.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
  if (encrypting) expect(await fs.readFile(file, 'utf8')).not.toContain('hunter2')
})

test('the archive carries what the main process imports, and nothing the renderer bundled', async () => {
  harness = await launch({ executablePath })
  const appPath = await harness.app.evaluate(({ app }) => app.getAppPath())

  const packed = new Set(
    asar
      .listPackage(appPath, { isPack: false })
      .filter((entry) => entry.startsWith(`${path.sep}node_modules${path.sep}`))
      .map((entry) => entry.split(path.sep)[2])
  )

  // Imported by name from the main bundle, so they must be here.
  for (const name of ['docx', 'ssh2', 'basic-ftp', 'chokidar', 'fast-xml-parser', 'fflate']) {
    expect(packed).toContain(name)
  }

  // Bundled into the renderer by Vite and never resolved at runtime. This is
  // the only check that can catch one of them being misfiled as a runtime
  // dependency, because a packaged app behaves identically either way.
  for (const name of ['react', 'react-dom', '@tiptap', 'zustand', 'dockview-react']) {
    expect(packed).not.toContain(name)
  }
})
