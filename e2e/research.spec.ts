import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { PubDocument } from '../src/shared/model/document.js'
import type { CslItem } from '../src/shared/model/source.js'
import type { PdfHighlightFile, ResearchAttachment } from '../src/shared/model/research.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

/** Create a source through the store, the way `citations.spec.ts` does. */
async function createSource(title: string): Promise<CslItem> {
  const result = await harness.page.evaluate(async (sourceTitle) => {
    const source = await window.__pub.sources.getState().create('article-journal')
    if (!source) return { error: 'create returned null' }
    window.__pub.sources.getState().patch(source.id, { title: sourceTitle })
    await window.__pub.sources.getState().flush()
    const found = window.__pub.sources.getState().sources.find((candidate) => candidate.id === source.id)
    return found ?? { error: 'not found after patch', createdId: source.id }
  }, title)
  if ((result as { error?: string }).error) {
    throw new Error(`createSource failed: ${JSON.stringify(result)}`)
  }
  return result as CslItem
}

async function savedDocument(file: string): Promise<PubDocument> {
  return readJson<PubDocument>(path.join(harness.projectDir, file))
}

function attachmentHighlightsFile(sourceId: string, attachmentId: string): string {
  return path.join(harness.projectDir, '.thepub', 'research', sourceId, `${attachmentId}.highlights.json`)
}

test('a PDF attachment can be highlighted and cited, with the citation carrying the page locator', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  const source = await createSource('A Fixture Paper')

  const pdfPath = path.resolve(import.meta.dirname, 'fixtures/sample.pdf')
  const bytesBase64 = (await fs.readFile(pdfPath)).toString('base64')

  const attachment: ResearchAttachment = await harness.page.evaluate(
    ({ sourceId, bytesBase64: bytes }) =>
      window.pub.invoke('research:attachments:addPdf', { sourceId, bytesBase64: bytes, label: 'sample.pdf' }),
    { sourceId: source.id, bytesBase64 }
  )
  expect(attachment.kind).toBe('pdf')

  // The attachment's own file exists under .thepub/research/, never inside
  // the project's own file tree.
  const attachmentPath = path.join(harness.projectDir, '.thepub', 'research', source.id, `${attachment.id}.pdf`)
  await expect.poll(async () => fs.stat(attachmentPath).then(() => true).catch(() => false)).toBe(true)

  // Record a highlight through the same channel the reader's selection
  // handler uses (`PdfViewer`'s `saveHighlight`) — this is the sidecar the
  // Research panel's Sources tab reads from.
  const highlight = await harness.page.evaluate(
    ({ sourceId, attachmentId }) =>
      window.pub.invoke('research:highlights:save', {
        sourceId,
        attachmentId,
        highlight: {
          id: '',
          sourceId,
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
    { sourceId: source.id, attachmentId: attachment.id }
  )
  expect(highlight.page).toBe(1)

  await waitFor(async () => {
    const file = await readJson<PdfHighlightFile>(attachmentHighlightsFile(source.id, attachment.id)).catch(
      () => null
    )
    return file !== null && file.highlights.length === 1
  }, 'the PDF highlight to reach its sidecar file')

  // The Sources tab reads through `useResearchStore` (`researchStore.ts`);
  // exercise that store directly here rather than through panel UI, since
  // this test is about the citation side-effect, not panel rendering — see
  // the dedicated "opens without crashing" test below for that.
  const storeState = await harness.page.evaluate(async ({ sourceId, attachmentId }) => {
    await window.__pub.research.getState().loadAttachments(sourceId)
    await window.__pub.research.getState().loadHighlights(sourceId, attachmentId)
    const state = window.__pub.research.getState()
    return {
      attachments: state.attachmentsBySource[sourceId],
      highlights: state.highlightsByAttachment[`${sourceId}/${attachmentId}`]
    }
  }, { sourceId: source.id, attachmentId: attachment.id })
  expect(storeState.attachments).toHaveLength(1)
  expect(storeState.highlights).toHaveLength(1)
  expect(storeState.highlights![0]!.quote).toBe('quick brown fox')

  // `createDocument` leaves chapter-01 as the active tab/document already,
  // so cite-from-highlight has somewhere to insert into.
  //
  // Cited via `__pub`'s exposed `citeFromPdfHighlight` — the exact function
  // `ResearchPanel`'s Sources tab "Cite" button calls — asserting the
  // citation's effect on the saved document directly rather than driving it
  // through the panel's "Cite" button, which would just be a less direct way
  // of calling the same function.
  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror').first()).toBeVisible()
  await harness.page.evaluate(
    async ({ sourceId, quote, page }) => {
      const editor = window.__pub.getEditor(window.__pub.documents.getState().activeDocId!)!
      const placement = await window.__pub.citationPlacement('chicago-author-date')
      window.__pub.citeFromPdfHighlight(editor, sourceId, { quote, page }, placement, { includeQuote: true })
    },
    { sourceId: source.id, quote: 'quick brown fox', page: 1 }
  )

  await waitFor(async () => {
    const doc = await savedDocument(`chapter-01.pubdoc`).catch(() => null)
    if (!doc) return false
    return JSON.stringify(doc).includes('"kind":"citation"')
  }, 'the citation field to be saved into the document')

  const doc = await savedDocument('chapter-01.pubdoc')
  const raw = JSON.stringify(doc)
  expect(raw).toContain('"kind":"citation"')
  expect(raw).toContain(`"sourceIds":["${source.id}"]`)
  expect(raw).toContain('"locator":"1"')
  // The quote is pasted as a block quote above the citation.
  expect(raw).toContain('"type":"blockquote"')

  void docId
})

test('a web capture can be highlighted and cited, with no page locator', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'chapter-01.pubdoc')
  const source = await createSource('A Captured Page')

  const capture = { url: 'https://example.com/article', title: 'Example Article', text: 'The quick brown fox jumps over the lazy dog.', accessed: '2026-01-01' }
  const attachment: ResearchAttachment = await harness.page.evaluate(
    ({ sourceId, capture: cap }) =>
      window.pub.invoke('research:attachments:addCapture', { sourceId, capture: cap, label: cap.url }),
    { sourceId: source.id, capture }
  )
  expect(attachment.kind).toBe('capture')

  // The capture's own file exists under .thepub/research/, never inside the
  // project's own file tree — mirrors the PDF attachment's storage.
  const capturePath = path.join(harness.projectDir, '.thepub', 'research', source.id, `${attachment.id}.capture.json`)
  await expect.poll(async () => fs.stat(capturePath).then(() => true).catch(() => false)).toBe(true)

  const quote = 'quick brown fox'
  const highlight = await harness.page.evaluate(
    ({ sourceId, attachmentId, quote: q, offset }) =>
      window.pub.invoke('research:highlights:save', {
        sourceId,
        attachmentId,
        highlight: {
          id: '',
          sourceId,
          attachmentId,
          kind: 'capture',
          color: '#ffef8a',
          categoryId: '',
          note: '',
          authorId: '',
          quote: q,
          page: 0,
          rects: [],
          offset,
          orphaned: false,
          created: new Date().toISOString(),
          modified: new Date().toISOString()
        }
      }),
    { sourceId: source.id, attachmentId: attachment.id, quote, offset: capture.text.indexOf(quote) }
  )
  expect(highlight.kind).toBe('capture')
  expect(highlight.offset).toBe(capture.text.indexOf(quote))

  await waitFor(async () => {
    const file = await readJson<PdfHighlightFile>(attachmentHighlightsFile(source.id, attachment.id)).catch(
      () => null
    )
    return file !== null && file.highlights.length === 1
  }, 'the capture highlight to reach its sidecar file')

  const storeState = await harness.page.evaluate(async ({ sourceId, attachmentId }) => {
    await window.__pub.research.getState().loadAttachments(sourceId)
    await window.__pub.research.getState().loadHighlights(sourceId, attachmentId)
    const state = window.__pub.research.getState()
    return {
      attachments: state.attachmentsBySource[sourceId],
      highlights: state.highlightsByAttachment[`${sourceId}/${attachmentId}`]
    }
  }, { sourceId: source.id, attachmentId: attachment.id })
  expect(storeState.attachments).toHaveLength(1)
  expect(storeState.highlights).toHaveLength(1)
  expect(storeState.highlights![0]!.kind).toBe('capture')

  // Cited via `citeFromPdfHighlight`, the exact function the Sources tab's
  // "Cite" button calls — a capture highlight has no page, so the citation
  // carries no locator (unlike the PDF test above, which asserts `"locator":"1"`).
  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror').first()).toBeVisible()
  await harness.page.evaluate(
    async ({ sourceId, quote: q }) => {
      const editor = window.__pub.getEditor(window.__pub.documents.getState().activeDocId!)!
      const placement = await window.__pub.citationPlacement('chicago-author-date')
      window.__pub.citeFromPdfHighlight(editor, sourceId, { quote: q }, placement, { includeQuote: true })
    },
    { sourceId: source.id, quote }
  )

  await waitFor(async () => {
    const doc = await savedDocument(`chapter-01.pubdoc`).catch(() => null)
    if (!doc) return false
    return JSON.stringify(doc).includes('"kind":"citation"')
  }, 'the citation field to be saved into the document')

  const doc = await savedDocument('chapter-01.pubdoc')
  const raw = JSON.stringify(doc)
  expect(raw).toContain('"kind":"citation"')
  expect(raw).toContain(`"sourceIds":["${source.id}"]`)
  expect(raw).toContain('"locator":null')
  expect(raw).toContain('"type":"blockquote"')

  void docId
})

test('the Research panel opens without crashing the renderer', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  await harness.page.evaluate(() => window.__pub.runCommand('panel.research'))

  // A regression check for the "Maximum update depth exceeded" (React error
  // #185) that a Zustand selector returning a fresh `[]` literal on its
  // falsy branch triggers — the same footgun `NotesPanel` already avoids
  // with its own `NO_NOTES` constant. If the panel is mid-crash the dock
  // blanks and this text never appears. `createDocument` already leaves a
  // document active, so the panel renders its highlight-list branch rather
  // than the "open a document" empty state.
  await expect(harness.page.getByText('No highlights yet')).toBeVisible()

  await harness.page.locator('.pub-sheet:visible .ProseMirror').first().click()
  await harness.page.locator('.pub-sheet:visible .ProseMirror').first().pressSequentially('hello world')
  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror').first()).toContainText('hello world')

  // The panel is still alive after further editor activity — not merely
  // rendered once before crashing on the next state update.
  await expect(harness.page.getByText('No highlights yet')).toBeVisible()
})
