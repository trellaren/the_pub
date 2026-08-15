import { test, expect, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { unzipSync, strFromU8 } from 'fflate'
import { launch, openProject, createDocument, cleanup, waitFor, readJson, type Harness } from './helpers.js'
import type { ManuscriptFile, ManuscriptNode } from '../src/shared/model/manuscript.js'

let harness: Harness
let scratch = ''

test.beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-e2e-manuscript-'))
})

test.afterEach(async () => {
  if (harness) await cleanup(harness)
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
})

function manuscriptFile(): string {
  return path.join(harness.projectDir, '.thepub', 'manuscript.json')
}

async function storedNodes(): Promise<ManuscriptNode[]> {
  return (await readJson<ManuscriptFile>(manuscriptFile())).nodes
}

/** Type into whichever editor is currently on screen, and get it to disk. */
async function write(text: string): Promise<void> {
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await expect(editor).toBeVisible()
  await editor.click()
  await harness.page.keyboard.type(text)
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
}

async function openManuscript(): Promise<void> {
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('manuscript', 'Manuscript'))
}

function documentXml(bytes: Uint8Array): string {
  return strFromU8(unzipSync(bytes)['word/document.xml']!)
}

/**
 * A real HTML5 drag: down on the source, a short move to cross the browser's
 * drag threshold, then a stepped move onto the target so `dragover` fires
 * repeatedly along the way — a single jump would skip straight to `drop`
 * without ever exercising the aiming logic under test.
 */
// Near the left edge of a row, past its chevron and short of its title text —
// a part row also carries a role <select> and four buttons, which each claim
// their own mousedown and never let it bubble into a native dragstart. Real
// authors grab a row by its label for the same reason.
const GRAB_X = 24

async function dragTo(page: Page, sourceId: string, target: Locator, fraction: number): Promise<void> {
  const source = page.locator(`[data-node-id="${sourceId}"]`)
  const sourceBox = (await source.boundingBox())!
  const targetBox = (await target.boundingBox())!
  await page.mouse.move(sourceBox.x + GRAB_X, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox.x + GRAB_X + 4, sourceBox.y + sourceBox.height / 2 + 4, { steps: 5 })
  await page.mouse.move(targetBox.x + GRAB_X, targetBox.y + targetBox.height * fraction, { steps: 10 })
  await page.waitForTimeout(100)
  await page.mouse.up()
  await page.waitForTimeout(100)
}

async function nodeId(kind: 'part' | 'document', title: string): Promise<string> {
  return harness.page.evaluate(
    ({ kind: k, title: t }) =>
      window.__pub.manuscript
        .getState()
        .view.nodes.find((node) => node.kind === k && node.title === t)!.id,
    { kind, title }
  )
}

test.describe('building the book by clicking', () => {
  test('a part and two documents, added through the real toolbar', async () => {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)
    await createDocument(harness.page, 'chapter-one.pubdoc')
    await createDocument(harness.page, 'chapter-two.pubdoc')
    await openManuscript()

    await harness.page.getByRole('button', { name: 'Add part' }).click()
    await harness.page.getByTestId('prompt-input').fill('Part One')
    await harness.page.getByTestId('prompt-confirm').click()
    await expect(harness.page.getByTestId('manuscript-part')).toHaveCount(1)

    await harness.page.getByRole('button', { name: 'Add documents', exact: true }).click()
    await harness.page.getByTestId('document-picker-item').nth(0).click()
    await harness.page.getByTestId('document-picker-item').nth(1).click()
    await harness.page.getByTestId('document-picker-confirm').click()

    await expect(harness.page.getByTestId('manuscript-document')).toHaveCount(2)
    await waitFor(async () => (await storedNodes()).length === 3, 'the part and two documents to reach disk')
  })

  /* A document nobody ever adds is none of the binder's business — it must go
   * on being a perfectly normal file. */
  test('a document never added stays out of the book and otherwise unaffected', async () => {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)
    await createDocument(harness.page, 'notes.pubdoc')
    await write('Just some notes.')
    await openManuscript()

    await expect(harness.page.getByTestId('manuscript-document')).toHaveCount(0)

    // Still opens normally through the Explorer.
    await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('explorer', 'Explorer'))
    await harness.page.getByText('notes.pubdoc').click()
    await expect(harness.page.locator('.pub-sheet:visible .ProseMirror')).toContainText('Just some notes.')
  })
})

test.describe('reordering', () => {
  test('a native drag between levels moves exactly one node, aimed at the drawn target', async () => {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)
    await createDocument(harness.page, 'a.pubdoc')
    await createDocument(harness.page, 'b.pubdoc')
    await openManuscript()

    await harness.page.evaluate(() => window.__pub.manuscript.getState().createPart('Part One'))
    await harness.page.evaluate(() =>
      window.__pub.manuscript.getState().addDocuments(['a.pubdoc', 'b.pubdoc'])
    )
    const before = await storedNodes()
    const aId = await nodeId('document', 'a')
    const partId = await nodeId('part', 'Part One')

    const partRow = harness.page.locator('[data-node-id="' + partId + '"]')
    const source = harness.page.locator(`[data-node-id="${aId}"]`)
    const sourceBox = (await source.boundingBox())!
    const targetBox = (await partRow.boundingBox())!

    await harness.page.mouse.move(sourceBox.x + GRAB_X, sourceBox.y + sourceBox.height / 2)
    await harness.page.mouse.down()
    await harness.page.mouse.move(sourceBox.x + GRAB_X + 4, sourceBox.y + sourceBox.height / 2 + 4, { steps: 5 })
    await harness.page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 10
    })
    await harness.page.waitForTimeout(100)

    // Assert what the drag is aimed at *before* releasing — the diagnosable
    // half of a native-drag test: this tells a drag that never started apart
    // from one that started but resolved to the wrong place.
    const raw = await harness.page.locator('[data-testid="manuscript-tree"]').getAttribute('data-drop-target')
    const aimed = JSON.parse(raw!)
    expect(aimed.parentId).toBe(partId)
    expect(aimed.indicator.kind).toBe('inside')

    await harness.page.mouse.up()
    await harness.page.waitForTimeout(150)

    const after = await storedNodes()
    const changed = after.filter((node) => {
      const original = before.find((candidate) => candidate.id === node.id)
      return !original || JSON.stringify(original) !== JSON.stringify(node)
    })
    expect(changed.map((node) => node.id)).toEqual([aId])
    expect(changed[0]!.parentId).toBe(partId)
  })

  test('dropping onto an empty part’s placeholder puts the document inside it', async () => {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)
    await createDocument(harness.page, 'a.pubdoc')
    await openManuscript()

    await harness.page.evaluate(() => window.__pub.manuscript.getState().createPart('Part One'))
    await harness.page.evaluate(() => window.__pub.manuscript.getState().addDocuments(['a.pubdoc']))
    const aId = await nodeId('document', 'a')
    const partId = await nodeId('part', 'Part One')

    await expect(harness.page.getByTestId('manuscript-placeholder')).toHaveCount(1)
    await dragTo(harness.page, aId, harness.page.getByTestId('manuscript-placeholder'), 0.5)

    await waitFor(async () => {
      const node = (await storedNodes()).find((candidate) => candidate.id === aId)
      return node?.parentId === partId
    }, 'the document to land inside the part')
    await expect(harness.page.getByTestId('manuscript-placeholder')).toHaveCount(0)
  })

  test('dragging one part before another reorders the root', async () => {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)
    await openManuscript()

    await harness.page.evaluate(() => window.__pub.manuscript.getState().createPart('Part One'))
    await harness.page.evaluate(() => window.__pub.manuscript.getState().createPart('Part Two'))
    const firstId = await nodeId('part', 'Part One')
    const secondId = await nodeId('part', 'Part Two')

    // Top band of the first part's row: drop Part Two before it.
    await dragTo(harness.page, secondId, harness.page.locator(`[data-node-id="${firstId}"]`), 0.1)

    await waitFor(async () => {
      const ordered = [...(await storedNodes())].sort((a, b) => a.order - b.order)
      return ordered[0]!.id === secondId && ordered[1]!.id === firstId
    }, 'Part Two to move ahead of Part One')
  })

  test('the move buttons reorder without a mouse', async () => {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)
    await createDocument(harness.page, 'a.pubdoc')
    await createDocument(harness.page, 'b.pubdoc')
    await openManuscript()
    await harness.page.evaluate(() =>
      window.__pub.manuscript.getState().addDocuments(['a.pubdoc', 'b.pubdoc'])
    )
    const aId = await nodeId('document', 'a')

    await harness.page.locator(`[data-node-id="${aId}"]`).getByRole('button', { name: 'Move down' }).click()

    await waitFor(async () => {
      const ordered = [...(await storedNodes())].sort((x, y) => x.order - y.order)
      return ordered[0]!.id !== aId && ordered[1]!.id === aId
    }, 'the button to move the first document after the second')
  })

  test('indent and outdent move a document between the root and a part', async () => {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)
    await createDocument(harness.page, 'a.pubdoc')
    await openManuscript()
    await harness.page.evaluate(() => window.__pub.manuscript.getState().createPart('Part One'))
    await harness.page.evaluate(() => window.__pub.manuscript.getState().addDocuments(['a.pubdoc']))
    const aId = await nodeId('document', 'a')
    const partId = await nodeId('part', 'Part One')
    const row = harness.page.locator(`[data-node-id="${aId}"]`)

    await row.getByRole('button', { name: 'Indent into part above' }).click()
    await waitFor(async () => {
      const node = (await storedNodes()).find((candidate) => candidate.id === aId)
      return node?.parentId === partId
    }, 'the document to indent into the part')

    await row.getByRole('button', { name: 'Outdent to top level' }).click()
    await waitFor(async () => {
      const node = (await storedNodes()).find((candidate) => candidate.id === aId)
      return node?.parentId === null
    }, 'the document to outdent back to the root')
  })
})

test.describe('removing', () => {
  test('deleting a part keeps its chapters at the top level', async () => {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)
    await createDocument(harness.page, 'a.pubdoc')
    await openManuscript()
    await harness.page.evaluate(() => window.__pub.manuscript.getState().createPart('Part One'))
    await harness.page.evaluate(() => window.__pub.manuscript.getState().addDocuments(['a.pubdoc']))
    const aId = await nodeId('document', 'a')
    const partId = await nodeId('part', 'Part One')
    await harness.page.evaluate(
      ({ id, parentId }) => window.__pub.manuscript.getState().move(id, parentId, 0),
      { id: aId, parentId: partId }
    )
    await waitFor(async () => {
      const node = (await storedNodes()).find((candidate) => candidate.id === aId)
      return node?.parentId === partId
    }, 'the document to land inside the part')

    harness.page.on('dialog', (dialog) => dialog.accept())
    await harness.page
      .locator(`[data-node-id="${partId}"]`)
      .getByRole('button', { name: 'Remove part' })
      .click()

    await expect(harness.page.getByTestId('manuscript-part')).toHaveCount(0)
    await expect(harness.page.getByTestId('manuscript-document')).toHaveCount(1)
    await waitFor(async () => {
      const node = (await storedNodes()).find((candidate) => candidate.id === aId)
      return node?.parentId === null
    }, 'the chapter to survive at the root')
  })
})

test.describe('resolving against a live index', () => {
  test('a document renamed outside the app stays resolved', async () => {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)
    await createDocument(harness.page, 'chapter-one.pubdoc')
    await openManuscript()
    await harness.page.evaluate(() => window.__pub.manuscript.getState().addDocuments(['chapter-one.pubdoc']))
    const docId = await nodeId('document', 'chapter-one')

    // See the delete test below for why: the watcher's write-stability window
    // needs room to settle before an external mutation, or the event can go
    // unreported.
    await harness.page.waitForTimeout(1500)
    await fs.rename(
      path.join(harness.projectDir, 'chapter-one.pubdoc'),
      path.join(harness.projectDir, 'chapter-one-renamed.pubdoc')
    )

    await waitFor(async () => {
      const view = await harness.page.evaluate(() => window.__pub.manuscript.getState().view)
      const node = view.nodes.find((candidate) => candidate.id === docId)
      return node?.resolvedPath === 'chapter-one-renamed.pubdoc' && node.missing === false
    }, 'the row to follow the rename')
    await expect(harness.page.getByTestId('manuscript-missing')).toHaveCount(0)
  })

  test('a document deleted outside the app shows missing, reports on compile, then relinks', async () => {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)
    await createDocument(harness.page, 'chapter-one.pubdoc')
    await createDocument(harness.page, 'chapter-two.pubdoc')
    await openManuscript()
    await harness.page.evaluate(() =>
      window.__pub.manuscript.getState().addDocuments(['chapter-one.pubdoc', 'chapter-two.pubdoc'])
    )

    // Give the watcher's write-stability window room to settle before the
    // external delete — chokidar's `awaitWriteFinish` tracks a just-created
    // file for a moment, and deleting it inside that window can leave the
    // unlink unreported. A real author deleting a chapter they just made is
    // not operating on a sub-second timer either.
    await harness.page.waitForTimeout(1500)
    await fs.unlink(path.join(harness.projectDir, 'chapter-one.pubdoc'))
    await waitFor(async () => {
      const view = await harness.page.evaluate(() => window.pub.invoke('manuscript:view', {}))
      return view.nodes.some((node: { missing: boolean }) => node.missing)
    }, 'the row to report missing')

    // Compile still succeeds for what it could find, but says what it left out.
    const target = path.join(scratch, 'incomplete.docx')
    await harness.app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog
    }, target)
    await harness.page.getByRole('button', { name: 'Compile to Word' }).click()
    await waitFor(async () => fs.stat(target).then(() => true).catch(() => false), 'the incomplete compile to land')
    await expect(harness.page.getByTestId('notice-info')).toContainText('Could not find')

    // Relink recovers the row.
    await createDocument(harness.page, 'chapter-one-take-two.pubdoc')
    await openManuscript()
    await harness.page.getByTestId('manuscript-missing').locator('..').getByRole('button', { name: 'Relink…' }).click()
    await expect(harness.page.getByTestId('document-picker')).toBeVisible()
    await harness.page.getByTestId('document-picker-item').filter({ hasText: 'chapter-one-take-two' }).click()
    await harness.page.getByTestId('document-picker-confirm').click()

    await expect(harness.page.getByTestId('manuscript-missing')).toHaveCount(0)
  })
})

test.describe('compiling', () => {
  test('front matter precedes the first part, which exports as a heading with a page break', async () => {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)

    await createDocument(harness.page, 'dedication.pubdoc')
    await write('For my cat.')
    await createDocument(harness.page, 'chapter-one.pubdoc')
    await write('It was a dark and stormy night.')

    await openManuscript()
    await harness.page.evaluate(() => window.__pub.manuscript.getState().createPart('Front Matter'))
    await harness.page.evaluate(() => window.__pub.manuscript.getState().createPart('Part One'))
    const frontId = await nodeId('part', 'Front Matter')
    const partId = await nodeId('part', 'Part One')

    await harness.page
      .locator(`[data-node-id="${frontId}"]`)
      .getByRole('combobox', { name: 'Part role' })
      .selectOption('front')

    await harness.page.evaluate(
      ({ path: docPath, parentId }) => window.__pub.manuscript.getState().addDocuments([docPath], parentId),
      { path: 'dedication.pubdoc', parentId: frontId }
    )
    await harness.page.evaluate(
      ({ path: docPath, parentId }) => window.__pub.manuscript.getState().addDocuments([docPath], parentId),
      { path: 'chapter-one.pubdoc', parentId: partId }
    )

    const target = path.join(scratch, 'book.docx')
    await harness.app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog
    }, target)
    await harness.page.getByRole('button', { name: 'Compile to Word' }).click()
    await waitFor(async () => fs.stat(target).then(() => true).catch(() => false), 'the compiled file to land')

    const xml = documentXml(new Uint8Array(await fs.readFile(target)))
    expect(xml).toContain('Part One')
    expect(xml).toContain('<w:pageBreakBefore/>')
    expect(xml.indexOf('For my cat.')).toBeGreaterThan(-1)
    expect(xml.indexOf('It was a dark and stormy night.')).toBeGreaterThan(-1)
    expect(xml.indexOf('For my cat.')).toBeLessThan(xml.indexOf('It was a dark and stormy night.'))
  })
})
