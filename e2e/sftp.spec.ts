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

/**
 * Accept the server's SSH identity, the way an author would.
 *
 * Every test below this line needs it, because a host key nobody has accepted
 * is refused — and the test server mints a fresh one on each run, so there is
 * never anything accepted in advance. Done through the same two channels the
 * dialog uses rather than by writing the store directly, so the plumbing is
 * exercised even by the tests that are about something else.
 */
async function acceptHostKey(uri: string): Promise<void> {
  const id = uri.split('//')[1]!
  const accepted = await harness.page.evaluate(async (profileId) => {
    const probe = await window.pub.invoke('connections:test', { id: profileId })
    if (!probe.hostKey) return probe.ok
    const result = await window.pub.invoke('connections:trustHostKey', {
      id: profileId,
      fingerprint: probe.hostKey.fingerprint
    })
    return result.ok
  }, id)
  expect(accepted).toBe(true)
}

/** Save a profile and accept the server's identity, which is the usual case. */
async function connectedProfile(remotePath = '/'): Promise<string> {
  const uri = await saveProfile(remotePath)
  await acceptHostKey(uri)
  return uri
}

test('a saved server can be tested before a project is opened on it', async () => {
  harness = await launch()
  const uri = await connectedProfile()
  const id = uri.split('//')[1]!

  const result = await harness.page.evaluate(
    (profileId) => window.pub.invoke('connections:test', { id: profileId }),
    id
  )
  expect(result).toMatchObject({ ok: true, hostKey: null })
})

/*
 * Host keys, end to end.
 *
 * The adapter's own suite proves the decision; these prove the app is wired to
 * it — that a server nobody has vouched for cannot be reached at all, that the
 * fingerprint an author is shown is the server's real one, and that accepting
 * it in the dialog is what unblocks the connection. Before this the app passed
 * ssh2 no verifier, so every one of these connected happily to anything that
 * answered.
 */

test('a server whose identity is unknown is refused, and its fingerprint offered', async () => {
  harness = await launch()
  const uri = await saveProfile()
  const id = uri.split('//')[1]!

  const result = await harness.page.evaluate(
    (profileId) => window.pub.invoke('connections:test', { id: profileId }),
    id
  )

  expect(result.ok).toBe(false)
  expect(result.message).toContain('has not been verified')
  // Not any fingerprint: the one this server actually proves itself with.
  expect(result.hostKey).toMatchObject({
    verdict: 'unknown',
    algorithm: server!.hostKey.algorithm,
    fingerprint: server!.hostKey.fingerprint
  })
})

test('a project will not open on a server whose identity has not been accepted', async () => {
  harness = await launch()
  const uri = await saveProfile('unverified')

  const error = await harness.page.evaluate(async (target) => {
    try {
      await window.pub.invoke('project:open', { uri: target })
      return null
    } catch (thrown) {
      return String(thrown)
    }
  }, uri)

  expect(error).toContain('has not been verified')
  // Refusal happens during the key exchange, so the project was never opened
  // and nothing was written to a server that could not prove who it was.
  await expect(fs.readdir(path.join(serverRoot, 'unverified'))).resolves.toEqual([])
})

test('the connect dialog shows the fingerprint and accepting it opens the way', async () => {
  harness = await launch()
  await harness.page.getByTestId('open-connect').click()
  await expect(harness.page.getByTestId('connect-dialog')).toBeVisible()

  await harness.page.getByTestId('connect-host').fill('127.0.0.1')
  await harness.page.getByTestId('connect-user').fill('author')
  await harness.page.locator('input[type="number"]').fill(String(server!.port))
  await harness.page.getByTestId('connect-path').fill('/')
  await harness.page.getByRole('button', { name: 'Test the connection' }).click()

  // The fingerprint is shown in full so it can be compared character by
  // character with one obtained from the server another way.
  const panel = harness.page.getByTestId('connect-host-key')
  await expect(panel).toBeVisible()
  await expect(harness.page.getByTestId('connect-fingerprint')).toHaveText(
    `${server!.hostKey.algorithm} ${server!.hostKey.fingerprint}`
  )

  await harness.page.getByTestId('connect-accept-host-key').click()
  await expect(panel).toBeHidden()
  await expect(harness.page.getByTestId('connect-status')).toContainText('Connected to 127.0.0.1')
})

/*
 * The alarm, against a genuine substitution rather than a doctored store: the
 * first server is accepted at an address, then a different one answers there.
 */
test('a different server at the same address is refused, naming both fingerprints', async () => {
  harness = await launch()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-sftp-swap-e2e-'))
  const original = await startSftpServer(root)
  const port = original.port
  let substitute: TestServer | null = null

  try {
    const id = await harness.page.evaluate(
      async ({ port: at, privateKeyPath: key }) => {
        const profile = await window.pub.invoke('connections:save', {
          profile: {
            name: 'Moving target',
            protocol: 'sftp',
            host: '127.0.0.1',
            port: at,
            user: 'author',
            auth: 'key',
            privateKeyPath: key,
            remotePath: '/',
            secure: false
          },
          secret: ''
        })
        const saved = (profile as { id: string }).id
        const probe = await window.pub.invoke('connections:test', { id: saved })
        await window.pub.invoke('connections:trustHostKey', {
          id: saved,
          fingerprint: probe.hostKey!.fingerprint
        })
        return saved
      },
      { port, privateKeyPath: keyPath }
    )

    await original.close()
    substitute = await startSftpServer(root, { port })
    expect(substitute.hostKey.fingerprint).not.toBe(original.hostKey.fingerprint)

    const result = await harness.page.evaluate(
      (profileId) => window.pub.invoke('connections:test', { id: profileId }),
      id
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('has changed')
    expect(result.hostKey).toMatchObject({
      verdict: 'changed',
      fingerprint: substitute.hostKey.fingerprint,
      previous: original.hostKey.fingerprint
    })
  } finally {
    await substitute?.close()
    await original.close().catch(() => {})
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/*
 * The echo check on accepting a key. A dialog left open while the server
 * changed underneath it must not be able to commit a key nobody read.
 */
test('accepting a fingerprint that is not the one on offer is refused', async () => {
  harness = await launch()
  const uri = await saveProfile()
  const id = uri.split('//')[1]!

  const result = await harness.page.evaluate(async (profileId) => {
    await window.pub.invoke('connections:test', { id: profileId })
    return window.pub.invoke('connections:trustHostKey', {
      id: profileId,
      fingerprint: 'SHA256:somethingTheAuthorNeverSaw00000000000000000'
    })
  }, id)

  expect(result.ok).toBe(false)
  expect(result.message).toContain('out of date')

  // And the server is still refused afterwards.
  const after = await harness.page.evaluate(
    (profileId) => window.pub.invoke('connections:test', { id: profileId }),
    id
  )
  expect(after.ok).toBe(false)
})

test('a project opens over SFTP and scaffolds itself on the server', async () => {
  harness = await launch()
  const uri = await connectedProfile('scaffold')

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
  const uri = await connectedProfile('writes')
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
  const uri = await connectedProfile('indexing')
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
 * A PDF attached to a source, highlighted, then round-tripped through a
 * project close and reopen — all against the real local SFTP test server,
 * not a mock. Combines this file's own "document written over SFTP lands on
 * the server and reads back" pattern with `highlights.spec.ts`'s
 * close-and-reopen pattern, applied to `.thepub/research/` — the attachment
 * bytes and the highlight sidecar both live there, under `VfsAdapter`, same
 * as every other project file, so this is the practical stand-in this repo's
 * own convention uses for "a real remote server": genuine SFTP I/O over a
 * real `ssh2.Server`, not a substitute for OneDrive's own REST-API quirks,
 * which a generic `VfsAdapter` test like this one cannot exercise.
 */
test('a research attachment and its highlight round-trip over SFTP, across a project close and reopen', async () => {
  harness = await launch()
  const uri = await connectedProfile('research')
  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await harness.page.waitForFunction(() => window.__pub.project.getState().project !== null)

  const source = await harness.page.evaluate(async () => {
    const created = await window.__pub.sources.getState().create('article-journal')
    if (!created) return null
    window.__pub.sources.getState().patch(created.id, { title: 'A Server-Side Paper' })
    await window.__pub.sources.getState().flush()
    return created
  })
  expect(source).toBeTruthy()
  const sourceId = source!.id

  const pdfPath = path.resolve(import.meta.dirname, 'fixtures/sample.pdf')
  const bytesBase64 = (await fs.readFile(pdfPath)).toString('base64')

  const attachment = await harness.page.evaluate(
    ({ sourceId: id, bytesBase64: bytes }) =>
      window.pub.invoke('research:attachments:addPdf', { sourceId: id, bytesBase64: bytes, label: 'sample.pdf' }),
    { sourceId, bytesBase64 }
  ) as { id: string; kind: string }
  expect(attachment.kind).toBe('pdf')

  // The attachment bytes really are on the server, under `.thepub/research/`
  // — never anywhere in the project's own file tree.
  const attachmentPath = path.join(serverRoot, 'research', '.thepub', 'research', sourceId, `${attachment.id}.pdf`)
  await waitFor(async () => fs.stat(attachmentPath).then(() => true).catch(() => false), 'the PDF attachment to reach the server')
  const onServer = await fs.readFile(attachmentPath)
  expect(onServer.equals(await fs.readFile(pdfPath))).toBe(true)

  const highlight = await harness.page.evaluate(
    ({ sourceId: id, attachmentId }) =>
      window.pub.invoke('research:highlights:save', {
        sourceId: id,
        attachmentId,
        highlight: {
          id: '',
          sourceId: id,
          attachmentId,
          color: '#ffef8a',
          categoryId: '',
          note: '',
          authorId: '',
          quote: 'quick brown fox',
          page: 1,
          rects: [],
          orphaned: false,
          created: new Date().toISOString(),
          modified: new Date().toISOString()
        }
      }),
    { sourceId, attachmentId: attachment.id }
  ) as { id: string }

  const highlightsPath = path.join(
    serverRoot,
    'research',
    '.thepub',
    'research',
    sourceId,
    `${attachment.id}.highlights.json`
  )
  await waitFor(async () => fs.readFile(highlightsPath, 'utf8').then((raw) => raw.includes('quick brown fox')).catch(() => false), 'the highlight sidecar to reach the server')

  const { userDataDir } = harness
  await harness.app.close()

  harness = await launch({ userDataDir })
  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await harness.page.waitForFunction(() => window.__pub.project.getState().project !== null)

  // Both the source's attachment index and the highlight sidecar read back
  // correctly from the server after a full close/reopen — not just "the
  // bytes are still there", but the app's own read path over SFTP agrees
  // with what was written.
  const roundTripped = await harness.page.evaluate(
    async ({ sourceId: id, attachmentId, highlightId }) => {
      await window.__pub.research.getState().loadAttachments(id)
      await window.__pub.research.getState().loadHighlights(id, attachmentId)
      const state = window.__pub.research.getState()
      return {
        attachments: state.attachmentsBySource[id],
        highlights: state.highlightsByAttachment[`${id}/${attachmentId}`],
        highlightId
      }
    },
    { sourceId, attachmentId: attachment.id, highlightId: highlight.id }
  )
  expect(roundTripped.attachments).toHaveLength(1)
  expect(roundTripped.attachments![0]).toMatchObject({ id: attachment.id, kind: 'pdf' })
  expect(roundTripped.highlights).toHaveLength(1)
  expect(roundTripped.highlights![0]).toMatchObject({
    id: highlight.id,
    quote: 'quick brown fox',
    page: 1,
    orphaned: false
  })

  const bytes = await harness.page.evaluate(
    ({ sourceId: id, attachmentId }) => window.pub.invoke('research:attachments:readPdf', { sourceId: id, attachmentId }),
    { sourceId, attachmentId: attachment.id }
  ) as { bytesBase64: string }
  expect(Buffer.from(bytes.bytesBase64, 'base64').equals(await fs.readFile(pdfPath))).toBe(true)
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
  const uri = await connectedProfile('images')
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

/*
 * What the operating system can and cannot be asked to do with a remote file.
 *
 * Both of these handlers used to resolve a project-relative path against
 * `session.root` with `resolveInRoot`, which assumes the root is a directory on
 * this machine. For a project on a server the root is a URI, so the join
 * produced a path under the working directory that has nothing to do with
 * anything — the same mistake the asset protocol was carrying until Phase 11.
 */

test('deleting a file on a server really removes it from the server', async () => {
  harness = await launch()
  const uri = await connectedProfile('deleting')
  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await harness.page.waitForFunction(() => window.__pub.project.getState().project !== null)

  const file = path.join(serverRoot, 'deleting', 'doomed.pubdoc')
  await harness.page.evaluate(() => window.__pub.documents.getState().create('doomed.pubdoc'))
  await waitFor(async () => fs.readFile(file).then(() => true, () => false), 'the document to be written')

  const result = await harness.page.evaluate(() =>
    window.pub.invoke('vfs:delete', { path: 'doomed.pubdoc', recursive: false })
  )
  expect(result).toMatchObject({ ok: true })

  // The claim the handler makes is that the file is gone. On a local project
  // the OS trash is what makes that true; on a server there is no trash to move
  // it to, and reporting success without deleting anything would drop the row
  // from the tree while the chapter sat on the server.
  await expect(fs.readFile(file)).rejects.toThrow()
})

test('revealing a file on a server says it cannot, rather than opening nothing', async () => {
  harness = await launch()
  const uri = await connectedProfile('revealing')
  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await harness.page.waitForFunction(() => window.__pub.project.getState().project !== null)

  const error = await harness.page.evaluate(async () => {
    try {
      await window.pub.invoke('vfs:revealInOs', { path: 'chapter.pubdoc' })
      return null
    } catch (thrown) {
      return String(thrown)
    }
  })

  // There is no folder on this machine to open. Silently handing the file
  // manager a path assembled from a URI is worse than saying so.
  expect(error).toContain('on this machine')
})

test('the explorer offers no folder to reveal, and calls the delete what it is', async () => {
  harness = await launch()
  const uri = await connectedProfile('menus')
  // Put the file there before the project opens, so the tree's first listing
  // has it: a remote backend has no change notifications, and the poll that
  // would otherwise find it is fifteen seconds away.
  await fs.writeFile(path.join(serverRoot, 'menus', 'chapter.pubdoc'), '{}')

  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await harness.page.waitForFunction(() => window.__pub.project.getState().project !== null)
  await harness.page.evaluate(() => window.__pub.runCommand('panel.explorer'))
  await expect(harness.page.getByTestId('file-tree')).toBeVisible()

  const row = harness.page.getByRole('treeitem', { name: 'chapter.pubdoc' })
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })

  await expect(harness.page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
  await expect(harness.page.getByRole('menuitem', { name: 'Reveal in File Manager' })).toHaveCount(0)
  // Not "Move to Trash": there is no trash on a server, and an author who goes
  // looking for the chapter in a wastebasket that was never involved finds out
  // the hard way.
  await expect(harness.page.getByRole('menuitem', { name: 'Delete' })).toBeVisible()
})

test('the renderer is told whether a project is local, so it can hide what does not apply', async () => {
  harness = await launch()
  const uri = await connectedProfile('elsewhere')
  const project = await harness.page.evaluate(
    (target) => window.pub.invoke('project:open', { uri: target }),
    uri
  )
  expect(project.isLocal).toBe(false)
})

test('an asset url stops resolving once its project is closed', async () => {
  harness = await launch()
  const uri = await connectedProfile('closing')
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
