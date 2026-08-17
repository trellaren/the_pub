import { test, expect } from '@playwright/test'
import http from 'node:http'
import { launch, openProject, cleanup, waitFor, type Harness } from './helpers.js'
import type { CslItem } from '../src/shared/model/source.js'

let harness: Harness
let server: http.Server | null = null
let baseUrl = ''

async function startServer(): Promise<string> {
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(
      '<html><head><title>A Fixture Page</title></head><body>' +
        '<nav>skip me</nav><p>The quick brown fox jumps over the lazy dog.</p></body></html>'
    )
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('No address')
  return `http://127.0.0.1:${address.port}/article`
}

test.afterEach(async () => {
  if (harness) await cleanup(harness)
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

async function createSource(title: string): Promise<CslItem> {
  const result = await harness.page.evaluate(async (sourceTitle) => {
    const source = await window.__pub.sources.getState().create('webpage')
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

test('a web page can be captured from the Sources panel and read back as a text attachment', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  baseUrl = await startServer()
  const source = await createSource('A Fixture Page')

  await harness.page.evaluate(() => window.__pub.runCommand('panel.sources'))
  await harness.page.getByText('A Fixture Page').click()

  const urlInput = harness.page.getByTestId('capture-url')
  await expect(urlInput).toBeVisible()
  await urlInput.fill(baseUrl)
  await harness.page.getByRole('button', { name: 'Capture' }).click()

  // The attachment appears in the list once the main-process fetch and the
  // sidecar write both land — its label is the captured URL.
  await expect(harness.page.getByTitle(baseUrl)).toBeVisible()

  await waitFor(async () => {
    const state = await harness.page.evaluate(
      (sourceId) => window.__pub.research.getState().attachmentsBySource[sourceId],
      source.id
    )
    return Array.isArray(state) && state.length === 1
  }, 'the capture attachment to appear in the store')

  const attachment = await harness.page.evaluate(
    (sourceId) => window.__pub.research.getState().attachmentsBySource[sourceId]![0],
    source.id
  )
  expect(attachment.kind).toBe('capture')

  // The CSL item's own URL/accessed fields were merged in, so the capture's
  // provenance shows up in a bibliography without special-casing.
  const stored = await harness.page.evaluate(
    (sourceId) => window.__pub.sources.getState().sources.find((candidate) => candidate.id === sourceId),
    source.id
  )
  expect(stored?.URL).toBe(baseUrl)
  const accessed = stored?.accessed as { 'date-parts'?: number[][] } | undefined
  expect(accessed?.['date-parts']?.[0]).toBeTruthy()

  // Clicking the attachment opens the captured text, read-only, with the
  // <nav> stripped out by the reader-mode extraction.
  await harness.page.getByTitle(baseUrl).click()
  const captureText = harness.page.getByTestId('capture-text')
  await expect(captureText).toBeVisible()
  await expect(captureText).toContainText('The quick brown fox jumps over the lazy dog.')
  await expect(captureText).not.toContainText('skip me')
})
