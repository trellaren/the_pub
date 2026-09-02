import { test, expect } from '@playwright/test'
import http from 'node:http'
import path from 'node:path'
import { launch, openProject, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { ChatFile } from '../src/shared/model/ai.js'

let harness: Harness
let server: http.Server | null = null
let baseUrl = ''

/**
 * A stand-in for a local model server.
 *
 * LM Studio speaks the OpenAI dialect over plain HTTP on localhost, so a
 * fifteen-line server is enough to exercise the whole path for real: the main
 * process builds the request, streams the response, parses the events, and the
 * renderer renders and stores the reply. Mocking at any layer above this would
 * leave the part most likely to break untested.
 */
async function startModelServer(chunks: string[]): Promise<string> {
  server = http.createServer((request, response) => {
    if (request.url?.endsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'stub-model' }] }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of chunks) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
    }
    response.write('data: [DONE]\n\n')
    response.end()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('No address')
  return `http://127.0.0.1:${address.port}`
}

test.afterEach(async () => {
  if (harness) await cleanup(harness)
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

function chatsFile(): string {
  return path.join(harness.projectDir, '.thepub', 'chats.json')
}

async function useLocalServer(): Promise<void> {
  await harness.page.evaluate((url) => {
    const store = window.__pub.chats.getState()
    return store.saveSettings({
      provider: 'lmstudio',
      model: 'stub-model',
      baseUrl: url,
      temperature: 0.7,
      maxTokens: 512,
      systemPrompt: 'Be brief.',
      agent: false,
      embedModel: ''
    })
  }, baseUrl)
}

test('a chat is created, named after the first message, and stored', async () => {
  baseUrl = await startModelServer(['It ', 'opens ', 'well.'])
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useLocalServer()

  const chat = await harness.page.evaluate(() => window.__pub.chats.getState().createChat())
  await harness.page.evaluate(
    (id) => window.__pub.chats.getState().send(id, 'Read this scene.', ''),
    chat!.id
  )

  await waitFor(async () => {
    const file = await readJson<ChatFile>(chatsFile())
    return file.chats[0]?.messages.length === 2
  }, 'the exchange to be written')

  const file = await readJson<ChatFile>(chatsFile())
  expect(file.chats[0]!.title).toBe('Read this scene.')
  expect(file.chats[0]!.messages[1]!.role).toBe('assistant')
  // The reply is the concatenation of the streamed chunks.
  expect(file.chats[0]!.messages[1]!.text).toBe('It opens well.')
  expect(file.chats[0]!.messages[1]!.model).toBe('stub-model')
})

test('the reply streams into the panel and can be inserted into the manuscript', async () => {
  baseUrl = await startModelServer(['The storm ', 'broke at dusk.'])
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useLocalServer()

  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
  await harness.page.locator('[data-testid="chat-input"]').fill('Suggest an opening line.')
  await harness.page.locator('[data-testid="chat-send"]').click()

  const assistant = harness.page.locator('[data-testid="chat-assistant"]')
  await expect(assistant).toContainText('The storm broke at dusk.')

  // The reply can be put into the document as an ordinary, undoable edit.
  await harness.page.evaluate(() => window.__pub.documents.getState().create('chapter-01.pubdoc'))
  const docId = await harness.page.evaluate(async () => {
    const documents = window.__pub.documents.getState()
    const id = Object.keys(documents.docs)[0]!
    const state = documents.docs[id]!
    window.__pub.layout.getState().openEditor(id, state.path, state.title)
    return id
  })
  expect(docId).toBeTruthy()

  await harness.page.locator('.pub-sheet:visible .ProseMirror').click()

  // The panel and the document share a group by default, so opening the
  // document put it in front of the chat. Bring the chat back to click Insert —
  // the reply goes to the document that is active, not the one on screen.
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
  await assistant.getByRole('button', { name: 'Insert this at the cursor' }).click()

  await harness.page.evaluate((id) => {
    const state = window.__pub.documents.getState().docs[id]!
    window.__pub.layout.getState().openEditor(id, state.path, state.title)
  }, docId)
  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror')).toContainText(
    'The storm broke at dusk.'
  )
})

test('settings and chats survive reopening the project', async () => {
  baseUrl = await startModelServer(['ok'])
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useLocalServer()
  await harness.page.evaluate(() => window.__pub.chats.getState().createChat('Kept'))
  await waitFor(async () => (await readJson<ChatFile>(chatsFile())).chats.length === 1, 'the chat to be written')

  const { projectDir, userDataDir } = harness
  await harness.app.close()
  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)
  await harness.page.evaluate(() => window.__pub.chats.getState().load())

  const state = await harness.page.evaluate(() => ({
    titles: window.__pub.chats.getState().chats.map((chat) => chat.title),
    provider: window.__pub.chats.getState().settings?.provider
  }))
  expect(state.titles).toEqual(['Kept'])
  expect(state.provider).toBe('lmstudio')
})

test('a hosted provider with no key refuses to send rather than failing silently', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const chat = await harness.page.evaluate(() => window.__pub.chats.getState().createChat())
  const error = await harness.page.evaluate(async (id) => {
    try {
      await window.pub.invoke('ai:send', { chatId: id, text: 'Hello', context: '' })
      return null
    } catch (thrown) {
      return String(thrown)
    }
  }, chat!.id)

  expect(error).toContain('No API key')
  // Nothing was sent, so nothing was recorded.
  const file = await readJson<ChatFile>(chatsFile())
  expect(file.chats[0]!.messages).toEqual([])
})

test('key status is reported without ever handing back a key', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const status = await harness.page.evaluate(() => window.pub.invoke('ai:keyStatus', {}))
  expect(status).toHaveProperty('configured')
  expect(status).toHaveProperty('secureStorage')
  // There is deliberately no channel that returns a key to the renderer.
  expect(JSON.stringify(status)).not.toContain('sk-')
})
