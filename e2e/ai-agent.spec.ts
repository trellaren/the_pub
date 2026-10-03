import { test, expect } from '@playwright/test'
import http from 'node:http'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { ChatFile } from '../src/shared/model/ai.js'

let harness: Harness
let server: http.Server | null = null
let baseUrl = ''

/**
 * A stand-in for a local model that calls tools.
 *
 * Scripted turn by turn and spoken over real HTTP in the OpenAI dialect, so the
 * whole path runs for real: main builds the request with the tool
 * declarations, streams the response, splits tool calls out of the text, runs
 * the tool against the actual project, feeds the result back, and the renderer
 * renders what came out. A mock at any layer above this would step over the
 * parts most likely to break.
 */
type Turn = { text?: string; call?: { name: string; args: unknown } }

async function startAgentServer(turns: Turn[]): Promise<{ url: string; requests: () => unknown[] }> {
  const requests: unknown[] = []
  let step = 0

  server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      requests.push(JSON.parse(body || '{}'))
      const turn = turns[Math.min(step, turns.length - 1)]!
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
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests }
}

test.afterEach(async () => {
  if (harness) await cleanup(harness)
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

async function useAgent(): Promise<void> {
  await harness.page.evaluate((url) => {
    return window.__pub.chats.getState().saveSettings({
      provider: 'lmstudio',
      model: 'stub-model',
      baseUrl: url,
      temperature: 0.7,
      maxTokens: 512,
      systemPrompt: '',
      embedModel: ''
    })
  }, baseUrl)
}

async function ask(text: string): Promise<void> {
  const chat = await harness.page.evaluate(() => window.__pub.chats.getState().createChat())
  await harness.page.evaluate(
    ([id, question]) => window.__pub.chats.getState().send(id!, question!, ''),
    [chat!.id, text]
  )
}

test('the agent searches the project and reports what it did', async () => {
  const agent = await startAgentServer([
    { call: { name: 'search_manuscript', args: { query: 'harbour' } } },
    { text: 'You describe the harbour in chapter one.' }
  ])
  baseUrl = agent.url

  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useAgent()
  // The panel is what subscribes to the reply stream, so it has to be mounted
  // before anything is sent.
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))

  await ask('Where do I describe the harbour?')

  // The reply is the answer, not the tool call — the split that makes the
  // parts union worth having.
  await expect(harness.page.getByTestId('chat-assistant').last()).toContainText(
    'You describe the harbour in chapter one.'
  )
  // And what it did is shown beside what it said.
  await expect(harness.page.getByTestId('tool-trail').last()).toContainText('Searched for "harbour"')

  // Two requests: the call, then the answer with the result fed back.
  await waitFor(async () => agent.requests().length === 2, 'both agent requests')
  const second = agent.requests()[1] as { messages: { role: string }[] }
  expect(second.messages.some((message) => message.role === 'tool')).toBe(true)

  // The trail is persisted with the message, so it is still there months later.
  const file = await readJson<ChatFile>(path.join(harness.projectDir, '.thepub', 'chats.json'))
  const assistant = file.chats[0]!.messages.find((message) => message.role === 'assistant')
  expect(assistant?.toolCalls?.[0]?.name).toBe('search_manuscript')
})

test('a suggested edit lands as a tracked change the author judges, never as a write', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'scene.pubdoc')

  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await editor.press('T')
  await editor.pressSequentially('he harbour was quiet.')
  await expect(editor).toContainText('The harbour was quiet.')
  await harness.page.evaluate((id) => window.__pub.documents.getState().save(id), docId)

  const agent = await startAgentServer([
    {
      call: {
        name: 'suggest_edit',
        args: { path: 'scene.pubdoc', find: 'harbour was quiet', replace: 'harbour lay quiet', reason: 'Tighter.' }
      }
    },
    { text: 'One suggestion in the document.' }
  ])
  baseUrl = agent.url
  await useAgent()
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))

  await ask('Tighten the opening.')
  await expect(harness.page.getByTestId('chat-assistant').last()).toContainText('One suggestion in the document.')

  // The AI panel took the editor's tab group; bring the scene back to check it.
  await harness.page.evaluate((id) => {
    const state = window.__pub.documents.getState().docs[id]!
    window.__pub.layout.getState().openEditor(id, state.path, state.title)
  }, docId)

  // The suggestion is in the prose as Phase 9 marks, stamped with the
  // assistant's own id — not a card in the panel, and not a silent rewrite.
  const struck = editor.locator('del.pub-deletion[data-author^="assistant-"]')
  const added = editor.locator('ins.pub-insertion[data-author^="assistant-"]')
  await expect(struck).toContainText('harbour was quiet')
  await expect(added).toContainText('harbour lay quiet')

  // Rejecting it from the Review panel restores the sentence exactly: the
  // verdict is the writer's, through the machinery every reviewer uses.
  await harness.page.evaluate(() => window.__pub.runCommand('panel.review'))
  // One row per mark: the struck-through words and the inserted ones are
  // judged separately, as they are for any reviewer.
  const reject = harness.page.getByRole('button', { name: 'Reject' })
  await expect(reject).toHaveCount(2)
  await reject.first().click()
  await expect(reject).toHaveCount(1)
  await reject.first().click()
  await expect(reject).toHaveCount(0)
  await expect(editor).toContainText('The harbour was quiet.')
  await expect(editor).not.toContainText('lay quiet')
})

test('a suggestion for a document that is not open is written to its file as marks', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'closed.pubdoc')
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await editor.press('T')
  await editor.pressSequentially('he gulls were loud.')
  await expect(editor).toContainText('The gulls were loud.')
  await harness.page.evaluate((id) => window.__pub.documents.getState().save(id), docId)
  await harness.page.evaluate((id) => window.__pub.documents.getState().close(id), docId)

  const agent = await startAgentServer([
    { call: { name: 'suggest_edit', args: { path: 'closed.pubdoc', find: 'were loud', replace: 'were screaming' } } },
    { text: 'Suggested.' }
  ])
  baseUrl = agent.url
  await useAgent()
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
  await ask('Make the gulls louder.')
  await expect(harness.page.getByTestId('chat-assistant').last()).toContainText('Suggested.')

  // Main applied the same edit function to the file: the old words are still
  // there under a deletion, the new ones under an insertion, both the
  // assistant's.
  await waitFor(async () => {
    const onDisk = await readJson<{ content: unknown }>(path.join(harness.projectDir, 'closed.pubdoc'))
    return JSON.stringify(onDisk.content).includes('"insertion"')
  }, 'the suggestion to reach the file')
  const onDisk = await readJson<{ content: { content: { content: { text: string; marks?: { type: string; attrs: { authorId: string } }[] }[] }[] } }>(
    path.join(harness.projectDir, 'closed.pubdoc')
  )
  const runs = onDisk.content.content[0]!.content
  const deleted = runs.find((run) => run.marks?.some((mark) => mark.type === 'deletion'))
  const inserted = runs.find((run) => run.marks?.some((mark) => mark.type === 'insertion'))
  expect(deleted?.text).toBe('were loud')
  expect(inserted?.text).toBe('were screaming')
  expect(inserted?.marks?.[0]?.attrs.authorId).toMatch(/^assistant-/)
})

test('the next turn replays what the agent did, so it does not search twice', async () => {
  const agent = await startAgentServer([
    { call: { name: 'search_manuscript', args: { query: 'harbour' } } },
    { text: 'Chapter one.' },
    { text: 'As I said, chapter one.' }
  ])
  baseUrl = agent.url

  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useAgent()
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))

  await ask('Where do I describe the harbour?')
  await expect(harness.page.getByTestId('chat-assistant').last()).toContainText('Chapter one.')

  const chatId = await harness.page.evaluate(() => window.__pub.chats.getState().activeChatId)
  await harness.page.evaluate(
    ([id, question]) => window.__pub.chats.getState().send(id!, question!, ''),
    [chatId, 'Remind me?']
  )
  await expect(harness.page.getByTestId('chat-assistant').last()).toContainText('As I said, chapter one.')

  await waitFor(async () => agent.requests().length === 3, 'the third request')
  const third = agent.requests()[2] as { messages: { role: string; tool_calls?: unknown[]; tool_call_id?: string }[] }
  expect(third.messages.some((message) => message.role === 'assistant' && message.tool_calls?.length)).toBe(true)
  expect(third.messages.some((message) => message.role === 'tool')).toBe(true)
})
