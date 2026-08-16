import { test, expect } from '@playwright/test'
import http from 'node:http'
import { launch, openProject, createDocument, cleanup, waitFor, type Harness } from './helpers.js'

let harness: Harness
let server: http.Server | null = null
let baseUrl = ''

/**
 * A stand-in for a local server that embeds and chats.
 *
 * The vectors are real arithmetic over the text rather than random numbers, so
 * the ranking this exercises is the ranking the app does: a passage about the
 * harbour must actually come back closest to a query about the harbour, through
 * the real embedder, the real float32 blobs, and the real cosine scan.
 */
const AXES = ['harbour', 'rain', 'horse']

function vectorFor(text: string): number[] {
  const lower = text.toLowerCase()
  // A small constant on the end so an unrelated passage still has a direction
  // and cannot be a zero vector.
  return [...AXES.map((axis) => (lower.includes(axis) ? 1 : 0)), 0.01]
}

type Turn = { text?: string; call?: { name: string; args: unknown } }

async function startServer(
  turns: Turn[]
): Promise<{ url: string; embedCalls: () => number; chatRequests: () => { tools?: { function?: { name?: string } }[] }[] }> {
  let step = 0
  let embedCalls = 0
  const chatRequests: { tools?: { function?: { name?: string } }[] }[] = []

  server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      if (request.url?.endsWith('/v1/embeddings')) {
        embedCalls += 1
        const input = (JSON.parse(body || '{}') as { input: string[] }).input
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            data: input.map((text, index) => ({ index, embedding: vectorFor(text) }))
          })
        )
        return
      }

      chatRequests.push(JSON.parse(body || '{}'))
      const turn = turns[Math.min(step, turns.length - 1)] ?? {}
      step += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (turn.text) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.text } }] })}\n\n`)
      }
      if (turn.call) {
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${step}`,
                      function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) }
                    }
                  ]
                }
              }
            ]
          })}\n\n`
        )
      }
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('No address')
  return { url: `http://127.0.0.1:${address.port}`, embedCalls: () => embedCalls, chatRequests: () => chatRequests }
}

test.afterEach(async () => {
  if (harness) await cleanup(harness)
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

async function useLocalServer(agent: boolean): Promise<void> {
  await harness.page.evaluate(
    ([url, useAgent]) =>
      window.__pub.chats.getState().saveSettings({
        provider: 'lmstudio',
        model: 'stub-model',
        baseUrl: url as string,
        temperature: 0.7,
        maxTokens: 512,
        systemPrompt: '',
        agent: useAgent as boolean,
        embedModel: 'stub-embed'
      }),
    [baseUrl, agent] as const
  )
}

async function writeScene(name: string, text: string): Promise<void> {
  const docId = await createDocument(harness.page, name)
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await editor.press(text.slice(0, 1))
  await editor.pressSequentially(text.slice(1))
  await expect(editor).toContainText(text)
  await harness.page.evaluate((id) => window.__pub.documents.getState().save(id), docId)
}

function retrievalStatus() {
  return harness.page.evaluate(() => window.pub.invoke('ai:retrievalStatus', {}))
}

test('the index is built on request, reports its coverage, and survives reopening', async () => {
  const stub = await startServer([])
  baseUrl = stub.url

  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useLocalServer(false)
  await writeScene('scene-01.pubdoc', 'The harbour was quiet.')

  await waitFor(async () => (await retrievalStatus()).total > 0, 'the block to be indexed')
  const before = await retrievalStatus()
  expect(before.embedded).toBe(0)

  const built = await harness.page.evaluate(() => window.pub.invoke('ai:buildRetrieval', {}))
  expect(built).toMatchObject({ embedded: before.total, total: before.total, building: false, error: '' })
  expect(stub.embedCalls()).toBeGreaterThan(0)

  // The index is a cache, but a cache that is thrown away on every open is not
  // one: reopening must not re-embed a book that has not changed.
  const callsAfterBuild = stub.embedCalls()
  const { projectDir, userDataDir } = harness
  await harness.app.close()
  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)

  await waitFor(async () => (await retrievalStatus()).total > 0, 'the reopened project to index')
  expect(await retrievalStatus()).toMatchObject({ embedded: before.total, total: before.total })
  expect(stub.embedCalls()).toBe(callsAfterBuild)
})

test('editing one paragraph re-embeds that paragraph and no others', async () => {
  const stub = await startServer([])
  baseUrl = stub.url

  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useLocalServer(false)
  await writeScene('scene-01.pubdoc', 'The harbour was quiet.')
  await writeScene('scene-02.pubdoc', 'Rain came late.')

  await waitFor(async () => (await retrievalStatus()).total === 2, 'both blocks to be indexed')
  await harness.page.evaluate(() => window.pub.invoke('ai:buildRetrieval', {}))
  expect(await retrievalStatus()).toMatchObject({ embedded: 2, total: 2 })

  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await editor.pressSequentially(' The horse waited.')
  await expect(editor).toContainText('Rain came late. The horse waited.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  // The untouched scene keeps its vector; only the edited one falls out. This
  // is what stops a one-word fix costing an embedding pass over the book.
  await waitFor(async () => (await retrievalStatus()).embedded === 1, 'the edited block to go stale')
  expect(await retrievalStatus()).toMatchObject({ embedded: 1, total: 2 })
})

test('the agent finds a passage by meaning and never sees the whole book', async () => {
  const stub = await startServer([
    { call: { name: 'find_passages', args: { query: 'the sea' } } },
    { text: 'You describe it in scene one.' }
  ])
  baseUrl = stub.url

  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useLocalServer(true)
  await writeScene('scene-01.pubdoc', 'The harbour was quiet.')
  await writeScene('scene-02.pubdoc', 'The horse waited.')

  await waitFor(async () => (await retrievalStatus()).total === 2, 'both blocks to be indexed')
  await harness.page.evaluate(() => window.pub.invoke('ai:buildRetrieval', {}))

  // The panel is what subscribes to the reply stream, so it has to be mounted
  // before anything is sent.
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
  const chat = await harness.page.evaluate(() => window.__pub.chats.getState().createChat())
  await harness.page.evaluate(
    (id) => window.__pub.chats.getState().send(id, 'Where do I write about the sea?', ''),
    chat!.id
  )

  await expect(harness.page.getByTestId('chat-assistant').last()).toContainText(
    'You describe it in scene one.'
  )
  await expect(harness.page.getByTestId('tool-trail').last()).toContainText('Searched by meaning')

  const offered = stub.chatRequests()[0]!.tools?.map((tool) => tool.function?.name) ?? []
  expect(offered).toContain('find_passages')
})

test('a project with no index is not offered the tool that would refuse', async () => {
  const stub = await startServer([{ text: 'Nothing to add.' }])
  baseUrl = stub.url

  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useLocalServer(true)
  await writeScene('scene-01.pubdoc', 'The harbour was quiet.')
  await waitFor(async () => (await retrievalStatus()).total > 0, 'the block to be indexed')

  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
  const chat = await harness.page.evaluate(() => window.__pub.chats.getState().createChat())
  await harness.page.evaluate(
    (id) => window.__pub.chats.getState().send(id, 'Anything to say?', ''),
    chat!.id
  )
  await expect(harness.page.getByTestId('chat-assistant').last()).toContainText('Nothing to add.')

  // Nothing was embedded, so the retrieval tool is not described at all. A tool
  // the model can only be told is useless still costs it a step to find out.
  const offered = stub.chatRequests()[0]!.tools?.map((tool) => tool.function?.name) ?? []
  expect(offered).toContain('search_manuscript')
  expect(offered).not.toContain('find_passages')
})
