import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { launch, createDocument, cleanup, waitFor, type Harness } from './helpers.js'

let harness: Harness
let dbDir = ''
let dbFile = ''

/**
 * A project that lives in a database.
 *
 * SQLite, because it needs no server to stand up and is the same engine the
 * search index already runs on — and because the dialect seam is the only thing
 * that differs between engines, so everything above it that this exercises is
 * exactly what Postgres and MySQL would run.
 */
test.beforeEach(async () => {
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-db-'))
  dbFile = path.join(dbDir, 'novel.pubdb')
})

test.afterEach(async () => {
  if (harness) await cleanup(harness)
  await fs.rm(dbDir, { recursive: true, force: true })
})

async function saveProfile(schema = 'thepub'): Promise<string> {
  return harness.page.evaluate(
    async ({ file, schema: name }) => {
      const profile = await window.pub.invoke('connections:save', {
        profile: {
          name: 'Test database',
          protocol: 'db',
          engine: 'sqlite',
          host: file,
          user: '',
          schema: name
        },
        secret: ''
      })
      return (profile as { id: string }).id
    },
    { file: dbFile, schema }
  )
}

test('a database with no project in it is an offer, not a failure', async () => {
  harness = await launch()
  const id = await saveProfile()

  const result = await harness.page.evaluate(
    (profileId) => window.pub.invoke('connections:test', { id: profileId }),
    id
  )

  // Reachable and empty are different answers from unreachable, and the dialog
  // turns this one into a button rather than an error to interpret.
  expect(result.ok).toBe(true)
  expect(result.needsCreate).toBe(true)
  expect(result.message).toContain('no project here yet')
})

test('opening a project on an empty database refuses rather than creating tables', async () => {
  harness = await launch()
  const id = await saveProfile()

  const error = await harness.page.evaluate(async (profileId) => {
    try {
      await window.pub.invoke('project:open', { uri: `db://${profileId}` })
      return null
    } catch (thrown) {
      return String(thrown)
    }
  }, id)

  // Creating tables in someone's database is not a side effect of opening a
  // project. It happens because a person read a sentence and pressed a button.
  expect(error).toContain('no project in this database')
})

test('a project created in a database holds its documents, and an empty folder, across a reopen', async () => {
  harness = await launch()
  const id = await saveProfile()

  const created = await harness.page.evaluate(
    (profileId) => window.pub.invoke('connections:createDatabase', { id: profileId }),
    id
  )
  expect(created.ok).toBe(true)

  const uri = `db://${id}`
  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await waitFor(
    async () => (await harness.page.evaluate(() => window.__pub.project.getState().project)) !== null,
    'the database project to open'
  )

  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await editor.press('T')
  await editor.pressSequentially('he harbour was quiet.')
  await expect(editor).toContainText('The harbour was quiet.')
  await harness.page.evaluate((target) => window.__pub.documents.getState().save(target), docId)

  // An empty folder is the case that makes directories rows rather than
  // inferred prefixes: inferring them loses this one silently.
  await harness.page.evaluate(() => window.pub.invoke('vfs:mkdir', { path: 'notes' }))

  const { userDataDir } = harness
  await harness.app.close()
  harness = await launch({ userDataDir })
  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), uri)
  await waitFor(
    async () => (await harness.page.evaluate(() => window.__pub.project.getState().project)) !== null,
    'the database project to reopen'
  )

  const listing = await harness.page.evaluate(() => window.pub.invoke('vfs:list', { path: '' }))
  const paths = listing.map((entry: { path: string }) => entry.path)
  expect(paths).toContain('chapter-01.pubdoc')
  expect(paths).toContain('notes')

  const reopened = await harness.page.evaluate(async () => {
    const documents = window.__pub.documents.getState()
    const id = await documents.openPath('chapter-01.pubdoc')
    if (!id) return null
    const state = window.__pub.documents.getState().docs[id]!
    window.__pub.layout.getState().openEditor(id, state.path, state.title)
    return id
  })
  expect(reopened).toBeTruthy()
  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror')).toContainText(
    'The harbour was quiet.'
  )

  // The whole project is in the one file, which is the point: nothing here is
  // half-copied by a file-sync client.
  const stats = await fs.stat(dbFile)
  expect(stats.size).toBeGreaterThan(0)
})

test('two projects share one database without seeing each other', async () => {
  harness = await launch()
  const first = await saveProfile('book_one')
  const second = await saveProfile('book_two')

  for (const id of [first, second]) {
    const created = await harness.page.evaluate(
      (profileId) => window.pub.invoke('connections:createDatabase', { id: profileId }),
      id
    )
    expect(created.ok).toBe(true)
  }

  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), `db://${first}`)
  await waitFor(
    async () => (await harness.page.evaluate(() => window.__pub.project.getState().project)) !== null,
    'the first project to open'
  )
  await harness.page.evaluate(() => window.__pub.documents.getState().create('only-in-one.pubdoc'))
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  await harness.page.evaluate((target) => window.__pub.project.getState().open(target), `db://${second}`)
  await waitFor(async () => {
    const listing = await harness.page.evaluate(() => window.pub.invoke('vfs:list', { path: '' }))
    return !listing.some((entry: { path: string }) => entry.path === 'only-in-one.pubdoc')
  }, 'the second project to be its own')

  const listing = await harness.page.evaluate(() => window.pub.invoke('vfs:list', { path: '' }))
  expect(listing.map((entry: { path: string }) => entry.path)).not.toContain('only-in-one.pubdoc')
})

test('a saved database server survives a restart, and is listed with its schema', async () => {
  harness = await launch()
  const id = await saveProfile('book_one')

  const { userDataDir } = harness
  await harness.app.close()
  harness = await launch({ userDataDir })

  const { connections } = await harness.page.evaluate(() => window.pub.invoke('connections:list', {}))
  const profile = connections.find((candidate: { id: string }) => candidate.id === id)
  expect(profile).toMatchObject({ protocol: 'db', engine: 'sqlite', schema: 'book_one' })
  // No channel ever hands back a secret. `hasSecret` is the whole of what the
  // renderer learns — `auth` names the *method*, and is not one.
  expect(profile).not.toHaveProperty('secret')
  expect(profile).toMatchObject({ hasSecret: false })
})
