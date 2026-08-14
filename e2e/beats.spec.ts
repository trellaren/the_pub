import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { BeatFile } from '../src/shared/model/beat.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

function beatsFile(): string {
  return path.join(harness.projectDir, '.thepub', 'beats.json')
}

async function addBeat(title: string, columnId?: string) {
  return harness.page.evaluate(
    ({ title: beatTitle, columnId: column }) =>
      window.__pub.beats.getState().create(beatTitle, column),
    { title, columnId }
  )
}

async function storedBeats(): Promise<BeatFile['beats']> {
  return (await readJson<BeatFile>(beatsFile())).beats
}

test('a board is seeded with acts and beats reach disk', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.__pub.beats.getState().load())

  const columns = await harness.page.evaluate(() =>
    window.__pub.beats.getState().columns.map((column) => column.name)
  )
  expect(columns).toEqual(['Act I', 'Act II', 'Act III'])

  await addBeat('The storm arrives')
  await waitFor(async () => (await storedBeats()).length === 1, 'the beat to reach beats.json')
  expect((await storedBeats())[0]!.title).toBe('The storm arrives')
})

test('beats keep their board order and survive a restart', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.__pub.beats.getState().load())

  await addBeat('One')
  await addBeat('Two')
  await addBeat('Three')

  const { projectDir, userDataDir } = harness
  await harness.app.close()
  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)
  await harness.page.evaluate(() => window.__pub.beats.getState().load())

  const titles = await harness.page.evaluate(() =>
    window.__pub.beats
      .getState()
      .beats.slice()
      .sort((a, b) => a.order - b.order)
      .map((beat) => beat.title)
  )
  expect(titles).toEqual(['One', 'Two', 'Three'])
})

test('dragging a card reorders the column and writes one beat', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.__pub.beats.getState().load())

  await addBeat('One')
  await addBeat('Two')
  const third = await addBeat('Three')

  await waitFor(async () => (await storedBeats()).length === 3, 'all three beats to be written')
  const before = await storedBeats()

  // Drop 'Three' between 'One' and 'Two'.
  await harness.page.evaluate((id) => {
    window.__pub.beats.getState().moveInColumn(id, 'act-1', 1)
    return window.__pub.beats.getState().flush()
  }, third!.id)

  await waitFor(async () => {
    const titles = (await storedBeats()).sort((a, b) => a.order - b.order).map((beat) => beat.title)
    return titles.join() === ['One', 'Three', 'Two'].join()
  }, 'the reorder to be written')

  // Fractional keys mean one card moved, not a renumbering of the column.
  const after = await storedBeats()
  const unchanged = after.filter((beat) => {
    const previous = before.find((candidate) => candidate.id === beat.id)!
    return previous.order === beat.order
  })
  expect(unchanged).toHaveLength(2)
})

test('the timeline orders by story time, not by board order', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.__pub.beats.getState().load())

  const first = await addBeat('Told first')
  const second = await addBeat('Told second')

  // A flashback: the beat told first happens later in the story.
  await harness.page.evaluate(
    ({ a, b }) => {
      const store = window.__pub.beats.getState()
      store.patch(a, { when: { label: 'Day 9', sort: null } })
      store.patch(b, { when: { label: 'Day 1', sort: null } })
      return store.flush()
    },
    { a: first!.id, b: second!.id }
  )

  await waitFor(async () => {
    const stored = await storedBeats()
    return stored.every((beat) => beat.when.sort !== null)
  }, 'the labels to be read into sort keys')

  const stored = await storedBeats()
  expect(stored.find((beat) => beat.title === 'Told first')!.when.sort).toBe(9)
  expect(stored.find((beat) => beat.title === 'Told second')!.when.sort).toBe(1)

  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('timeline', 'Timeline'))
  const rendered = harness.page.locator('[data-testid="timeline-list"] [data-testid="beat-card"]')
  await expect(rendered).toHaveCount(2)
  // Chronological order, which is the opposite of the order they were added.
  await expect(rendered.first()).toContainText('Told second')
})

test('dragging an undated beat into the timeline dates it', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.__pub.beats.getState().load())

  const early = await addBeat('Day 1')
  const late = await addBeat('Day 5')
  const floating = await addBeat('Somewhere between')

  await harness.page.evaluate(
    ({ a, b }) => {
      const store = window.__pub.beats.getState()
      store.patch(a, { when: { label: 'Day 1', sort: null } })
      store.patch(b, { when: { label: 'Day 5', sort: null } })
      return store.flush()
    },
    { a: early!.id, b: late!.id }
  )
  await waitFor(async () => (await storedBeats()).filter((beat) => beat.when.sort !== null).length === 2,
    'the two dated beats to settle')

  await harness.page.evaluate((id) => {
    window.__pub.beats.getState().moveInChronology(id, 1)
    return window.__pub.beats.getState().flush()
  }, floating!.id)

  await waitFor(async () => {
    const beat = (await storedBeats()).find((candidate) => candidate.id === floating!.id)!
    return beat.when.sort === 3
  }, 'the dropped beat to be dated between its neighbours')
})

test('a beat links to a paragraph and opens it again', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.__pub.beats.getState().load())
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')

  const editor = harness.page.locator('.pub-sheet .ProseMirror')
  await editor.click()
  await harness.page.keyboard.type('A quiet morning.\nThen the storm broke.')

  const beat = await addBeat('The storm')
  await harness.page.evaluate(
    ({ id, doc }) => {
      window.__pub.beats.getState().patch(id, { docId: doc, blockIndex: 1 })
      return window.__pub.beats.getState().flush()
    },
    { id: beat!.id, doc: docId }
  )

  await waitFor(async () => {
    const stored = (await storedBeats())[0]!
    return stored.docId === docId && stored.blockIndex === 1
  }, 'the scene link to be written')

  // The link stores a document id, so it survives the file being renamed.
  await harness.page.evaluate(() =>
    window.pub.invoke('vfs:rename', { from: 'chapter-01.pubdoc', to: 'renamed.pubdoc' })
  )
  await waitFor(
    async () =>
      (await harness.page.evaluate(
        (id) => window.pub.invoke('doc:resolve', { docId: id }),
        docId
      )) !== null,
    'the index to catch the rename'
  )

  const opened = await harness.page.evaluate(async (id) => {
    const target = window.__pub.beats.getState().beats.find((candidate) => candidate.id === id)!
    const resolved = await window.pub.invoke('doc:resolve', { docId: target.docId! })
    return Boolean(resolved)
  }, beat!.id)
  expect(opened).toBe(true)
})

test('the storyboard renders its columns and cards', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.__pub.beats.getState().load())
  await addBeat('Opening', 'act-1')
  await addBeat('Climax', 'act-3')

  await harness.page.evaluate(() =>
    window.__pub.layout.getState().showPanel('storyboard', 'Storyboard')
  )

  await expect(harness.page.locator('[data-testid="board-column"]')).toHaveCount(3)
  await expect(
    harness.page.locator('[data-column-id="act-1"] [data-testid="beat-card"]')
  ).toContainText('Opening')
  await expect(
    harness.page.locator('[data-column-id="act-3"] [data-testid="beat-card"]')
  ).toContainText('Climax')
})
