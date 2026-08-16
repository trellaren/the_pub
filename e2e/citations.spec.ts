import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { PubDocument } from '../src/shared/model/document.js'
import type { CslItem } from '../src/shared/model/source.js'
import type { SourceFile } from '../src/shared/model/source.js'

let harness: Harness

function sourcesFile(): string {
  return path.join(harness.projectDir, '.thepub', 'sources.json')
}

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

/** Create a source the way the Sources panel does, and return it. */
async function createSource(title: string, familyName: string, year: number): Promise<CslItem> {
  return harness.page.evaluate(
    async ({ title: sourceTitle, familyName: family, year: issuedYear }) => {
      const store = window.__pub.sources.getState()
      const source = await store.create('book')
      store.patch(source!.id, { title: sourceTitle, author: [{ family }], issued: { 'date-parts': [[issuedYear]] } })
      await store.flush()
      return store.sources.find((candidate) => candidate.id === source!.id)!
    },
    { title, familyName, year }
  )
}

async function setCitationStyle(styleId: string): Promise<void> {
  await harness.page.evaluate(
    (id) =>
      window.__pub.project
        .getState()
        .updateManifest((manifest) => ({ ...manifest, settings: { ...manifest.settings, citationStyleId: id } })),
    styleId
  )
}

async function editor() {
  const locator = harness.page.locator('.pub-sheet:visible .ProseMirror').first()
  await expect(locator).toBeVisible()
  return locator
}

async function citeSource(query: string): Promise<void> {
  await harness.page.keyboard.type(`[${query}`)
  await expect(harness.page.locator('[data-testid="citation-popup"]')).toBeVisible()
  await harness.page.keyboard.press('Enter')
}

async function savedDocument(file: string): Promise<PubDocument> {
  return readJson<PubDocument>(path.join(harness.projectDir, file))
}

test('the New source button creates a source through the Sources panel, and editing its title persists', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.__pub.runCommand('panel.sources'))

  await harness.page.getByRole('button', { name: 'New source' }).click()
  const titleInput = harness.page.getByTestId('source-title')
  await expect(titleInput).toBeVisible()
  await titleInput.fill('A Book About Ships')

  await harness.page.evaluate(() => window.__pub.sources.getState().flush())
  await waitFor(async () => {
    const titles = (await readJson<SourceFile>(sourcesFile())).sources.map((source) => source.title)
    return titles.includes('A Book About Ships')
  }, 'the source to be written')

  await expect(harness.page.getByTestId('source-list')).toContainText('A Book About Ships')
})

test('citing a source via [ inserts a rendered citation, and the refresh button updates the bibliography', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createSource('A Book About Ships', 'Smith', 2019)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const el = await editor()
  await el.click()
  await harness.page.keyboard.type('As shown ')
  await citeSource('Ships')

  const citation = harness.page.locator('.pub-field[data-field="citation"]')
  await expect(citation).toHaveCount(1)
  // Not the "…" placeholder — the picker's own refresh already ran.
  await expect(citation).toContainText('Smith')
  await expect(citation).toContainText('2019')

  await harness.page.getByRole('button', { name: 'Refresh citations and bibliography' }).click()
  const bibliography = harness.page.locator('.pub-field[data-field="bibliography"]')
  await expect(bibliography).toHaveCount(1)
  await expect(bibliography).toContainText('Smith')
  await expect(bibliography).toContainText('A Book About Ships')

  await waitFor(async () => {
    const saved = await savedDocument('chapter-01.pubdoc')
    return JSON.stringify(saved.content).includes('"citation"')
  }, 'the citation to be saved')
})

test('Chicago notes-bibliography places a citation in a footnote, and a repeat cite shortens', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await setCitationStyle('chicago-notes-bibliography')
  await createSource('A Book About Ships', 'Smith', 2019)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const el = await editor()
  await el.click()
  await harness.page.keyboard.type('First claim ')
  await citeSource('Ships')
  await harness.page.keyboard.press('End')
  await harness.page.keyboard.type(' Second claim ')
  await citeSource('Ships')

  const markers = harness.page.locator('.pub-footnote')
  await expect(markers).toHaveCount(2)
  const citations = harness.page.locator('.pub-field[data-field="citation"]')
  await expect(citations).toHaveCount(2)

  const first = (await citations.nth(0).textContent()) ?? ''
  const second = (await citations.nth(1).textContent()) ?? ''
  expect(first).toContain('2019')
  // A repeat citation to the same work shortens — the case a per-citation,
  // order-blind renderer cannot produce.
  expect(second).not.toBe(first)
  expect(second.length).toBeLessThan(first.length)

  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
  const { projectDir, userDataDir } = harness
  await harness.app.close()

  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)
  await harness.page.evaluate(async (target) => {
    const documents = window.__pub.documents.getState()
    const id = await documents.openPath(target)
    const state = window.__pub.documents.getState().docs[id!]!
    window.__pub.layout.getState().openEditor(id!, state.path, state.title)
  }, 'chapter-01.pubdoc')

  const reopenedCitations = harness.page.locator('.pub-field[data-field="citation"]')
  await expect(reopenedCitations).toHaveCount(2)
  await expect(reopenedCitations.nth(0)).toContainText('2019')
  await expect(reopenedCitations.nth(1)).toHaveText(second)
})
