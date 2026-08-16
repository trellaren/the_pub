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
      agent: true
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

test('a proposed edit is offered for review and never written by the agent', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'scene.pubdoc')

  await harness.page.locator('.pub-sheet:visible .ProseMirror').press('T')
  await harness.page.locator('.pub-sheet:visible .ProseMirror').pressSequentially('he harbour was quiet.')
  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror')).toContainText(
    'The harbour was quiet.'
  )
  await harness.page.evaluate((id) => window.__pub.documents.getState().save(id), docId)

  const agent = await startAgentServer([
    {
      call: {
        name: 'propose_edit',
        args: {
          path: 'scene.pubdoc',
          find: 'The harbour was quiet.',
          replace: 'The harbour lay quiet.',
          reason: 'Tighter.'
        }
      }
    },
    { text: 'One suggestion above.' }
  ])
  baseUrl = agent.url
  await useAgent()
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))

  await ask('Tighten the opening.')

  const card = harness.page.getByTestId('edit-proposal')
  await expect(card).toContainText('The harbour lay quiet.')

  // The document is untouched until the author acts. This is the rule the
  // whole design rests on.
  const onDisk = await readJson<{ content: unknown }>(
    path.join(harness.projectDir, 'scene.pubdoc')
  )
  expect(JSON.stringify(onDisk.content)).toContain('The harbour was quiet.')

  await harness.page.getByTestId('proposal-apply').click()
  await expect(card).toHaveCount(0)

  // Applying is an ordinary editor edit the author made, so it lands in the
  // open document.
  await harness.page.evaluate((id) => {
    const state = window.__pub.documents.getState().docs[id]!
    window.__pub.layout.getState().openEditor(id, state.path, state.title)
  }, docId)
  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror')).toContainText(
    'The harbour lay quiet.'
  )
})
