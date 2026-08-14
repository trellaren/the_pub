import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { PubDocument } from '../src/shared/model/document.js'
import type { EntityFile } from '../src/shared/model/entity.js'
import type { MentionHit } from '../src/shared/model/mention.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

function entitiesFile(): string {
  return path.join(harness.projectDir, '.thepub', 'entities.json')
}

/** Create a record the way the panel does, and return it. */
async function createRecord(name: string, kind: 'character' | 'location' = 'character') {
  return harness.page.evaluate(
    ({ name: recordName, kind: recordKind }) =>
      window.__pub.entities.getState().create(recordKind, recordName),
    { name, kind }
  )
}

async function mentionsFor(entityId: string): Promise<MentionHit[]> {
  return harness.page.evaluate(
    (id) => window.pub.invoke('mentions:forEntity', { entityId: id, limit: 100 }),
    entityId
  ) as Promise<MentionHit[]>
}

/** Confirm through the same path the backlink list's ✓ button uses. */
async function confirmMention(hit: MentionHit): Promise<boolean> {
  return harness.page.evaluate(async (target) => {
    const entity = window.__pub.entities
      .getState()
      .entities.find((candidate) => candidate.id === target.entityId)
    return entity ? window.__pub.confirmMention(target, entity) : false
  }, hit)
}

async function typeInto(text: string): Promise<void> {
  const editor = harness.page.locator('.pub-sheet .ProseMirror')
  await expect(editor).toBeVisible()
  await editor.click()
  await harness.page.keyboard.type(text)
}

async function savedDocument(file: string): Promise<PubDocument> {
  return readJson<PubDocument>(path.join(harness.projectDir, file))
}

test('a record is written to disk and survives reopening the project', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createRecord('Harlan')

  await waitFor(async () => {
    const file = await readJson<EntityFile>(entitiesFile())
    return file.entities.some((entity) => entity.name === 'Harlan')
  }, 'the record to reach entities.json')

  const stored = await readJson<EntityFile>(entitiesFile())
  expect(stored.entities[0]!.kind).toBe('character')
  expect(stored.entities[0]!.color).toBeTruthy()

  const { projectDir, userDataDir } = harness
  await harness.app.close()

  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)
  await waitFor(
    async () =>
      (await harness.page.evaluate(() => window.__pub.entities.getState().entities.length)) === 1,
    'the record to load with the project'
  )
})

test('typing a name suggests a mention and writes nothing to the document', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const record = await createRecord('Harlan')
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await typeInto('Harlan went north at dusk.')

  await waitFor(async () => (await mentionsFor(record!.id)).length > 0, 'a suggestion to be indexed')

  const hits = await mentionsFor(record!.id)
  expect(hits).toHaveLength(1)
  expect(hits[0]).toMatchObject({ confirmed: false, surface: 'Harlan', blockIndex: 0 })

  // The invariant the whole design rests on: a suggestion is an index entry,
  // never an edit. Nothing about the document changed.
  const saved = await savedDocument('chapter-01.pubdoc')
  expect(JSON.stringify(saved.content)).not.toContain('mention')
})

test('confirming a suggestion writes the mark and leaves the prose unchanged', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const record = await createRecord('Harlan')
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await typeInto('Harlan went north at dusk.')
  await waitFor(async () => (await mentionsFor(record!.id)).length > 0, 'a suggestion to be indexed')

  const before = await savedDocument('chapter-01.pubdoc')
  const hit = (await mentionsFor(record!.id))[0]!
  expect(await confirmMention(hit)).toBe(true)

  await waitFor(async () => {
    const saved = await savedDocument('chapter-01.pubdoc')
    return JSON.stringify(saved.content).includes('"mention"')
  }, 'the mark to be saved')

  const after = await savedDocument('chapter-01.pubdoc')
  expect(plainText(after)).toBe(plainText(before))
  expect(JSON.stringify(after.content)).toContain(record!.id)

  await waitFor(async () => {
    const hits = await mentionsFor(record!.id)
    return hits.length === 1 && hits[0]!.confirmed
  }, 'the index to show one confirmed mention')
})

test('a confirmed mention survives renaming the record', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const record = await createRecord('Harlan')
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await typeInto('Harlan went north at dusk.')
  await waitFor(async () => (await mentionsFor(record!.id)).length > 0, 'a suggestion to be indexed')

  const hit = (await mentionsFor(record!.id))[0]!
  await confirmMention(hit)
  await waitFor(async () => (await mentionsFor(record!.id))[0]?.confirmed === true, 'the confirmation')

  await harness.page.evaluate((id) => {
    window.__pub.entities.getState().patch(id, { name: 'Reed' })
    return window.__pub.entities.getState().flush()
  }, record!.id)

  // Marks carry the record's id, not its spelling, so the backlink is unmoved.
  await waitFor(async () => {
    const hits = await mentionsFor(record!.id)
    return hits.length === 1 && hits[0]!.confirmed && hits[0]!.surface === 'Harlan'
  }, 'the confirmed mention to survive the rename')
})

test('a backlink opens the document at the right paragraph', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const record = await createRecord('Ashfall', 'location')
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await typeInto('A quiet morning.\nThen the road to Ashfall.')

  await waitFor(async () => (await mentionsFor(record!.id)).length > 0, 'a suggestion to be indexed')
  const hit = (await mentionsFor(record!.id))[0]!
  expect(hit.blockIndex).toBe(1)

  const opened = await harness.page.evaluate(
    (target) =>
      window.__pub.openLocation({
        path: target.path,
        title: target.title,
        blockIndex: target.blockIndex,
        term: target.surface
      }),
    hit
  )
  expect(opened).toBe(true)
  await expect(harness.page.locator('.pub-sheet .ProseMirror')).toBeVisible()
})

test('@-autocomplete inserts a mention and leaves no @ in the text', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const record = await createRecord('Harlan')
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const editor = harness.page.locator('.pub-sheet .ProseMirror')
  await editor.click()
  await harness.page.keyboard.type('Then @Har')
  await expect(harness.page.locator('[data-testid="mention-popup"]')).toBeVisible()
  await harness.page.keyboard.press('Enter')
  await harness.page.keyboard.type('left.')

  await waitFor(async () => {
    const saved = await savedDocument('chapter-01.pubdoc')
    return JSON.stringify(saved.content).includes('"mention"')
  }, 'the mention to be saved')

  const saved = await savedDocument('chapter-01.pubdoc')
  const text = plainText(saved)
  expect(text).toContain('Then Harlan left.')
  // The @ is a trigger, not prose.
  expect(text).not.toContain('@')
  expect(JSON.stringify(saved.content)).toContain(record!.id)
})

test('@-autocomplete works in an editor torn out into its own window', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createRecord('Harlan')
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const before = harness.app.windows().length
  await harness.page.locator('[data-testid="popout-group"]').last().click()
  await waitFor(() => harness.app.windows().length > before, 'the popout window to open')

  const popout = harness.app.windows()[harness.app.windows().length - 1]!
  await popout.waitForLoadState('domcontentloaded')
  const editor = popout.locator('.pub-sheet .ProseMirror')
  await expect(editor).toBeVisible()
  await editor.click()
  await popout.keyboard.type('Then @Har')

  // The popup must be built in the popout's own document, not the opener's.
  await expect(popout.locator('[data-testid="mention-popup"]')).toBeVisible()
  await expect(harness.page.locator('[data-testid="mention-popup"]')).toHaveCount(0)

  await popout.keyboard.press('Enter')
  await waitFor(async () => {
    const saved = await savedDocument('chapter-01.pubdoc')
    return JSON.stringify(saved.content).includes('"mention"')
  }, 'the mention typed in the popout to be saved')
})

/** Concatenated text of every block, for comparing prose across an edit. */
function plainText(doc: PubDocument): string {
  const walk = (node: { text?: string; content?: unknown[] }): string => {
    if (typeof node.text === 'string') return node.text
    const children = (node.content ?? []) as { text?: string; content?: unknown[] }[]
    return children.map(walk).join('')
  }
  return ((doc.content.content ?? []) as { text?: string; content?: unknown[] }[])
    .map(walk)
    .join('\n')
}
