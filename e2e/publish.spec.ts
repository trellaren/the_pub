import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { launch, openProject, createDocument, cleanup, type Harness } from './helpers.js'

let harness: Harness
let scratch = ''

test.beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-e2e-publish-'))
})

test.afterEach(async () => {
  if (harness) await cleanup(harness)
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
})

async function write(text: string): Promise<void> {
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await expect(editor).toBeVisible()
  await editor.click()
  await harness.page.keyboard.type(text)
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
}

/**
 * PDF via the unified `publish:export` channel.
 *
 * `printToPDF` drives Chromium's real print pipeline, which needs a display
 * even offscreen — this is why `npm run e2e` runs under `xvfb-run` in this
 * repo already (see CLAUDE.md). If this test fails specifically on
 * `printToPDF`/`webContents.print` timing out or erroring in a way unrelated
 * to the manuscript content, that is the sandboxed-environment caveat
 * `docs/phase-12-plan.md` calls out: a real desktop (or a CI runner with a
 * working Xvfb + GPU-less Chromium software rendering path) is needed to
 * confirm this path end to end.
 */
test('exports a manuscript to PDF via publish:export and destroys the offscreen window', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await write('The lighthouse keeper counted the days, one lantern at a time.')

  const before = await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

  const target = path.join(scratch, 'manuscript.pdf')
  const result = await harness.page.evaluate(
    (file) =>
      window.pub.invoke('publish:export', {
        format: 'pdf',
        paths: ['chapter-01.pubdoc'],
        items: [],
        file
      }),
    target
  )
  expect(result).toMatchObject({ ok: true })

  const bytes = await fs.readFile(target)
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  // A real page, not an empty shell: %Page or /Type/Page markers appear once
  // per page in a PDF produced this way, so a non-trivial document has more
  // than the couple of bytes an empty print would.
  expect(bytes.byteLength).toBeGreaterThan(500)

  const after = await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  expect(after).toBe(before)
})

test('publish:exportDialog surfaces per-format warnings for EPUB and PDF', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const epubWarnings = await harness.page.evaluate(() => window.pub.invoke('publish:warnings', { format: 'epub' }))
  expect(epubWarnings.some((w: string) => w.toLowerCase().includes('page'))).toBe(true)

  const pdfWarnings = await harness.page.evaluate(() => window.pub.invoke('publish:warnings', { format: 'pdf' }))
  expect(pdfWarnings.some((w: string) => w.toLowerCase().includes('reflow'))).toBe(true)

  const docxWarnings = await harness.page.evaluate(() => window.pub.invoke('publish:warnings', { format: 'docx' }))
  expect(docxWarnings).toEqual([])
})
