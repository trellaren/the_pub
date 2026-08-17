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
  // exercise that store directly, since mounting the panel itself hits the
  // pre-existing crash noted below.
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
  // `ResearchPanel`'s Sources tab "Cite" button calls — rather than through
  // the panel's own UI: mounting the Research panel via `panel.research`
  // trips a pre-existing "Maximum update depth exceeded" (React error #185)
  // that predates this work and blanks the renderer. It is reproducible with
  // the unmodified `ResearchPanel` on `main` too (confirmed by temporarily
  // reverting this file's changes and repeating the same sequence — the
  // crash persists), so it is not this task's bug to fix. Worked around here
  // the same way the "highlights.spec.ts" test avoids asserting through the
  // panel after a reopen: exercise the real function against the real live
  // editor and confirm the effect it has on the saved document, rather than
  // driving it through the currently-crashing panel component.
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
