import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { unzipSync, strFromU8 } from 'fflate'
import { launch, openProject, createDocument, cleanup, waitFor, readJson, type Harness } from './helpers.js'
import { buildDocx, paragraph, run, WORD_STYLES } from '../src/main/docx/fixtures.js'
import type { ProjectManifest } from '../src/shared/model/manifest.js'

let harness: Harness
let scratch = ''

test.beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-e2e-docx-'))
})

test.afterEach(async () => {
  if (harness) await cleanup(harness)
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
})

/**
 * Type some prose into the open editor and get it on disk.
 *
 * Scoped to the visible sheet: a second open document leaves its editor mounted
 * in the hidden dock panel, so an unqualified locator matches both.
 */
async function write(text: string): Promise<void> {
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await expect(editor).toBeVisible()
  await editor.click()
  await harness.page.keyboard.type(text)
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
}

function documentXml(bytes: Uint8Array): string {
  return strFromU8(unzipSync(bytes)['word/document.xml']!)
}

test('a document exports to a .docx that carries the prose and the style', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await write('The lighthouse keeper counted the days.')

  const target = path.join(scratch, 'chapter.docx')
  const result = await harness.page.evaluate(
    (file) => window.pub.invoke('docx:export', { paths: ['chapter-01.pubdoc'], file }),
    target
  )
  expect(result).toMatchObject({ ok: true })

  const xml = documentXml(new Uint8Array(await fs.readFile(target)))
  expect(xml).toContain('The lighthouse keeper counted the days.')
  // The manuscript's own styles travel with it, so it stays editable in Word
  // the way it was here rather than arriving as flattened formatting.
  const parts = Object.keys(unzipSync(new Uint8Array(await fs.readFile(target))))
  expect(parts).toContain('word/styles.xml')
})

test('an exported document comes back in with its text and headings intact', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const editor = harness.page.locator('.pub-sheet .ProseMirror')
  await editor.click()
  // "# " is the editor's own shortcut for a level-1 heading, so this drives the
  // same path a writer would rather than reaching past the UI.
  await harness.page.keyboard.type('# Chapter One')
  await harness.page.keyboard.press('Enter')
  await harness.page.keyboard.type('The lamp had not been lit for nine days.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  const target = path.join(scratch, 'chapter.docx')
  await harness.page.evaluate(
    (file) => window.pub.invoke('docx:export', { paths: ['chapter-01.pubdoc'], file }),
    target
  )

  const imported = await harness.page.evaluate(
    (file) => window.pub.invoke('docx:import', { files: [file], targetDir: '' }),
    target
  )
  expect(imported.imported).toHaveLength(1)

  const written = await readJson<{ content: { content: { type: string; content?: unknown[] }[] } }>(
    path.join(harness.projectDir, imported.imported[0]!.path)
  )
  const blocks = written.content.content
  expect(blocks[0]!.type).toBe('heading')
  const text = JSON.stringify(blocks)
  expect(text).toContain('Chapter One')
  expect(text).toContain('The lamp had not been lit for nine days.')
})

test('a Word document maps onto the project’s styles and adds only what is new', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  // Written the way Word writes it, not the way this app's exporter does — that
  // is the whole point of importing from a hand-built fixture.
  const file = path.join(scratch, 'from-word.docx')
  await fs.writeFile(
    file,
    Buffer.from(
      buildDocx({
        styles: WORD_STYLES,
        body:
          paragraph(run('Chapter One'), '<w:pStyle w:val="Heading1"/>') +
          paragraph(run('Ordinary prose.'), '<w:pStyle w:val="Normal"/>') +
          paragraph(run('A quiet aside.'), '<w:pStyle w:val="Epigraph"/>')
      })
    )
  )

  const result = await harness.page.evaluate(
    (target) => window.pub.invoke('docx:import', { files: [target], targetDir: '' }),
    file
  )
  // Heading 1 and Normal already exist here; only Epigraph is genuinely new.
  expect(result.stylesAdded).toBe(1)

  const manifest = await readJson<ProjectManifest>(
    path.join(harness.projectDir, '.thepub', 'project.json')
  )
  expect(manifest.styles.map((style) => style.name)).toContain('Epigraph')

  const written = await readJson<{ content: { content: { attrs?: { styleId?: string } }[] } }>(
    path.join(harness.projectDir, result.imported[0]!.path)
  )
  const styleIds = written.content.content.map((block) => block.attrs?.styleId)
  expect(styleIds).toEqual(['heading-1', 'body', 'epigraph'])
})

test('an imported document is searchable straight away', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const file = path.join(scratch, 'indexed.docx')
  await fs.writeFile(
    file,
    Buffer.from(buildDocx({ body: paragraph(run('The lighthouse keeper counted the days.')) }))
  )
  await harness.page.evaluate(
    (target) => window.pub.invoke('docx:import', { files: [target], targetDir: '' }),
    file
  )

  await waitFor(async () => {
    const hits = await harness.page.evaluate(() =>
      window.pub.invoke('search:query', {
        text: 'lighthouse',
        limit: 20,
        matchCase: false,
        wholeWord: false
      })
    )
    return hits.length > 0
  }, 'the imported document to be indexed')
})

test('several documents export into one file, page-broken between', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  await createDocument(harness.page, 'chapter-01.pubdoc')
  await write('The first chapter.')
  await createDocument(harness.page, 'chapter-02.pubdoc')
  await write('The second chapter.')

  const target = path.join(scratch, 'book.docx')
  await harness.page.evaluate(
    (file) =>
      window.pub.invoke('docx:export', {
        paths: ['chapter-01.pubdoc', 'chapter-02.pubdoc'],
        file
      }),
    target
  )

  const xml = documentXml(new Uint8Array(await fs.readFile(target)))
  expect(xml).toContain('The first chapter.')
  expect(xml).toContain('The second chapter.')
  // One continuous manuscript is what an agent expects, not two files.
  expect(xml).toContain('pageBreakBefore')
})

test('a name Windows cannot store is refused with something readable', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const error = await harness.page.evaluate(async () => {
    try {
      await window.pub.invoke('vfs:rename', {
        from: 'chapter-01.pubdoc',
        to: 'Chapter: One.pubdoc'
      })
      return null
    } catch (thrown) {
      return String(thrown)
    }
  })
  // Legal on Linux, impossible on Windows — and this project may well be opened
  // on both, so it is refused everywhere rather than only where it would fail.
  expect(error).toContain('cannot contain :')

  const reserved = await harness.page.evaluate(async () => {
    try {
      await window.pub.invoke('vfs:mkdir', { path: 'CON' })
      return null
    } catch (thrown) {
      return String(thrown)
    }
  })
  expect(reserved).toContain('reserved device name')

  // The original is still there: a refused rename must not lose the file.
  expect(await fs.stat(path.join(harness.projectDir, 'chapter-01.pubdoc'))).toBeTruthy()
})
