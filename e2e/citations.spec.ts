import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs/promises'
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

/*
 * Phase 5's import surface. The dialog-free `sources:import` is what these
 * drive, for the reason the Word importer is split the same way: Playwright
 * cannot operate a native file dialog.
 */
test('a BibTeX file imports into the source library', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const bib = path.join(harness.projectDir, 'refs.bib')
  await fs.writeFile(
    bib,
    `@article{smith2019,
  title = {Attention and the {Reading} Brain},
  author = {Smith, Jane A. and Doe, John},
  journal = {Journal of Cognitive Science},
  year = {2019},
  pages = {201--229}
}
`,
    'utf8'
  )

  const result = await harness.page.evaluate(
    (file) => window.pub.invoke('sources:import', { files: [file] }),
    bib
  )
  expect(result.added).toBe(1)
  expect(result.skipped).toBe(0)

  await waitFor(async () => {
    const file = await readJson<SourceFile>(sourcesFile())
    const source = file.sources.find((candidate) => candidate.id === 'smith2019')
    // Brace-protected casing comes through as plain text, and the TeX en-dash
    // range as a plain one.
    return source?.title === 'Attention and the Reading Brain' && source.page === '201-229'
  }, 'the imported BibTeX source to reach sources.json')
})

test('a RIS file imports, and re-importing it updates rather than duplicating', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const ris = path.join(harness.projectDir, 'refs.ris')
  const write = (title: string): Promise<void> =>
    fs.writeFile(ris, `TY  - JOUR\nAU  - Smith, Jane\nTI  - ${title}\nPY  - 2019\nER  -\n`, 'utf8')

  await write('First Title')
  const first = await harness.page.evaluate(
    (file) => window.pub.invoke('sources:import', { files: [file] }),
    ris
  )
  expect(first.added).toBe(1)

  await write('Corrected Title')
  const second = await harness.page.evaluate(
    (file) => window.pub.invoke('sources:import', { files: [file] }),
    ris
  )
  // Re-importing a corrected file is how a typo gets fixed; doubling the
  // library for it would be a cleanup job for the author.
  expect(second).toMatchObject({ added: 0, replaced: 1 })

  await waitFor(async () => {
    const file = await readJson<SourceFile>(sourcesFile())
    return file.sources.length === 1 && file.sources[0]?.title === 'Corrected Title'
  }, 'the re-imported source to be updated in place')
})

test('an unreadable bibliography file is reported without losing the good one', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const good = path.join(harness.projectDir, 'good.bib')
  const bad = path.join(harness.projectDir, 'bad.bib')
  await fs.writeFile(good, '@book{ok2020, title = {Fine}, author = {Real, Author}, year = {2020}}\n', 'utf8')
  await fs.writeFile(bad, 'this file is not a bibliography at all\n', 'utf8')

  const result = await harness.page.evaluate(
    (files) => window.pub.invoke('sources:import', { files }),
    [good, bad]
  )

  expect(result.added).toBe(1)
  expect(result.warnings.join(' ')).toContain('bad.bib')
})

test('looking up something that is neither a DOI nor an ISBN says so, without a network call', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const result = await harness.page.evaluate(() =>
    window.pub.invoke('sources:lookup', { query: 'definitely not an identifier' })
  )

  expect(result).toEqual({ ok: false, reason: 'unsupported' })
})
