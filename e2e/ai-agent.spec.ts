import { test, expect } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { ChatFile } from '../src/shared/model/ai.js'
import type { ReviewFile } from '../src/shared/model/review.js'

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
  const reject = harness.page.getByRole('button', { name: 'Reject', exact: true })
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

test('a review comment lands in the margin as a thread by the Assistant, anchored to the quoted words', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'scene.pubdoc')
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await editor.press('T')
  await editor.pressSequentially('he harbour was quiet.')
  await expect(editor).toContainText('The harbour was quiet.')
  await harness.page.evaluate((id) => window.__pub.documents.getState().save(id), docId)

  const agent = await startAgentServer([
    { call: { name: 'comment', args: { path: 'scene.pubdoc', quote: 'was quiet', text: 'Quiet how? Give us a sound that is missing.' } } },
    { text: 'One comment in the margin.' }
  ])
  baseUrl = agent.url
  await useAgent()
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
  await ask('Review this scene.')
  await expect(harness.page.getByTestId('chat-assistant').last()).toContainText('One comment in the margin.')

  // The thread is the assistant's own file, never the writer's.
  const reviewsDir = path.join(harness.projectDir, '.thepub', 'reviews', docId)
  await waitFor(async () => (await fs.readdir(reviewsDir).catch(() => [])).length === 1, 'the review file')
  const [file] = await fs.readdir(reviewsDir)
  expect(file).toMatch(/^assistant-.*\.json$/)
  const review = await readJson<ReviewFile>(path.join(reviewsDir, file!))
  expect(review.threads[0]!.anchorText).toBe('was quiet')
  expect(JSON.stringify(review.threads[0]!.body)).toContain('Quiet how?')

  // The anchor reached the open editor, so the comment survives the next save
  // rather than being orphaned by it.
  await harness.page.evaluate((id) => {
    const state = window.__pub.documents.getState().docs[id]!
    window.__pub.layout.getState().openEditor(id, state.path, state.title)
  }, docId)
  await expect(editor.locator(`span[data-anchor-id="${review.threads[0]!.anchorId}"]`)).toContainText('was quiet')

  // And the Review panel names it as the Assistant's.
  await harness.page.evaluate(() => window.__pub.runCommand('panel.review'))
  await expect(harness.page.getByText('Quiet how? Give us a sound that is missing.')).toBeVisible()
  await expect(harness.page.locator('[title="Assistant"]').first()).toBeVisible()
})

test('a proofreading pass suggests each correction as a tracked change', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'scene.pubdoc')
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await editor.press('S')
  await editor.pressSequentially('he recieved no answer.')
  await expect(editor).toContainText('She recieved no answer.')
  await harness.page.evaluate((id) => window.__pub.documents.getState().save(id), docId)

  // Turn two is the nested copy-editing request the tool makes on its own,
  // answered in JSON; turn three is the agent's reply to the writer.
  const agent = await startAgentServer([
    { call: { name: 'proofread', args: { path: 'scene.pubdoc' } } },
    { text: JSON.stringify([{ block: 0, find: 'recieved', replace: 'received', reason: 'misspelt', kind: 'spelling' }]) },
    { text: 'One spelling fix suggested.' }
  ])
  baseUrl = agent.url
  await useAgent()
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
  await ask('Proofread this.')
  await expect(harness.page.getByTestId('chat-assistant').last()).toContainText('One spelling fix suggested.')
  await expect(harness.page.getByTestId('tool-trail').last()).toContainText('1 suggestion (1 spelling)')

  await harness.page.evaluate((id) => {
    const state = window.__pub.documents.getState().docs[id]!
    window.__pub.layout.getState().openEditor(id, state.path, state.title)
  }, docId)
  await expect(editor.locator('del.pub-deletion[data-author^="assistant-"]')).toContainText('recieved')
  await expect(editor.locator('ins.pub-insertion[data-author^="assistant-"]')).toContainText('received')
})

test('under a direct write policy the change lands at once, marked in the text and logged for good', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  const docId = await createDocument(harness.page, 'scene.pubdoc')
  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await editor.press('T')
  await editor.pressSequentially('he harbour was quiet.')
  await expect(editor).toContainText('The harbour was quiet.')
  await harness.page.evaluate((id) => window.__pub.documents.getState().save(id), docId)
  await harness.page.evaluate(() => window.pub.invoke('app:setAiWritePolicy', { policy: 'direct' }))

  const agent = await startAgentServer([
    { call: { name: 'suggest_edit', args: { path: 'scene.pubdoc', find: 'harbour was quiet', replace: 'harbour lay quiet', reason: 'Tighter.' } } },
    { text: 'Changed.' }
  ])
  baseUrl = agent.url
  await useAgent()
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
  await ask('Tighten the opening.')
  await expect(harness.page.getByTestId('chat-assistant').last()).toContainText('Changed.')
  await expect(harness.page.getByTestId('tool-trail').last()).toContainText('Changed scene')

  await harness.page.evaluate((id) => {
    const state = window.__pub.documents.getState().docs[id]!
    window.__pub.layout.getState().openEditor(id, state.path, state.title)
  }, docId)
  // No tracked change to judge — the words are simply there, attributed.
  await expect(editor).toContainText('The harbour lay quiet.')
  await expect(editor.locator('ins.pub-insertion')).toHaveCount(0)
  await expect(editor.locator('.pub-ai-authored')).toContainText('harbour lay quiet')

  // The log reached the file.
  type Envelope = { provenance?: { mode: string; excerpt: string; chars: number }[] }
  await waitFor(async () => Boolean((await readJson<Envelope>(path.join(harness.projectDir, 'scene.pubdoc'))).provenance?.length), 'the log to be saved')
  const logged = await readJson<Envelope>(path.join(harness.projectDir, 'scene.pubdoc'))
  expect(logged.provenance).toEqual([expect.objectContaining({ mode: 'direct', excerpt: 'harbour lay quiet', chars: 17 })])

  // Clearing formatting over the words keeps the attribution; deleting the
  // words removes it from the text but never from the log.
  await harness.page.evaluate((id) => {
    const live = window.__pub.getEditor(id)!
    live.chain().setTextSelection({ from: 1, to: live.state.doc.content.size - 1 }).unsetAllMarks().run()
  }, docId)
  await expect(editor.locator('.pub-ai-authored')).toContainText('harbour lay quiet')
  await harness.page.evaluate((id) => {
    const live = window.__pub.getEditor(id)!
    live.chain().setTextSelection({ from: 1, to: live.state.doc.content.size - 1 }).deleteSelection().insertContent('Rewritten by hand.').run()
  }, docId)
  await expect(editor.locator('.pub-ai-authored')).toHaveCount(0)
  await harness.page.evaluate((id) => window.__pub.documents.getState().save(id), docId)
  const after = await readJson<Envelope>(path.join(harness.projectDir, 'scene.pubdoc'))
  expect(after.provenance).toHaveLength(1)

  // And the Review panel lists it from the log, words or no words.
  await harness.page.evaluate(() => window.__pub.runCommand('panel.review'))
  await expect(harness.page.getByTestId('provenance-log')).toContainText('harbour lay quiet')
})

test('with web access set to pages you name, the assistant reads only those, and cites what it read', async () => {
  // A page on this machine stands in for the web; the gate must still let it
  // through only because the writer named it.
  const pageServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<html><head><title>Lisbon Docks 1954</title></head><body><p>Dockworkers earned forty escudos a day.</p></body></html>')
  })
  await new Promise<void>((resolve) => pageServer.listen(0, '127.0.0.1', resolve))
  const pageAddress = pageServer.address()
  if (typeof pageAddress === 'string' || !pageAddress) throw new Error('No address')
  // Loopback is private by the gate's rules, so the fixture is reached by a
  // name the resolver maps there, which the harness lists as a fixture host
  // (QUOTH_E2E_FIXTURE_HOSTS) — without that, the resolved-address check
  // refuses it like any other name pointing at this machine.
  const pageUrl = `http://localtest.me:${pageAddress.port}/docks`

  try {
    harness = await launch()
    await openProject(harness.page, harness.projectDir)
    await harness.page.evaluate(() => window.pub.invoke('app:setAiWeb', { webAccess: 'urls' }))

    const agent = await startAgentServer([
      { call: { name: 'fetch_page', args: { url: `http://localtest.me:${pageAddress.port}/elsewhere` } } },
      { call: { name: 'fetch_page', args: { url: pageUrl } } },
      { call: { name: 'cite_page', args: { url: pageUrl, claim: 'Dockworkers earned forty escudos a day.' } } },
      { text: 'Cited the page you gave me.' }
    ])
    baseUrl = agent.url
    await useAgent()
    await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
    await ask(`What does ${pageUrl} say dockworkers earned?`)
    await expect(harness.page.getByTestId('chat-assistant').last()).toContainText('Cited the page you gave me.')

    const trail = harness.page.getByTestId('tool-trail').last()
    await expect(trail).toContainText('Refused to fetch')
    await expect(trail).toContainText('Read Lisbon Docks 1954')
    await expect(trail).toContainText('Cited "Lisbon Docks 1954" (captured)')

    // Search was never on offer at this level.
    const first = agent.requests()[0] as { tools: { function: { name: string } }[] }
    const offered = first.tools.map((tool) => tool.function.name)
    expect(offered).toContain('fetch_page')
    expect(offered).not.toContain('web_search')

    // A draft source, with the page's text attached and the date it was read.
    type SourceFile = { sources: { title: string; URL?: string; accessed?: unknown; _pubProvisional?: boolean; _pubAttachments?: { kind: string }[] }[] }
    const file = await readJson<SourceFile>(path.join(harness.projectDir, '.thepub', 'sources.json'))
    expect(file.sources).toHaveLength(1)
    expect(file.sources[0]).toMatchObject({ title: 'Lisbon Docks 1954', URL: pageUrl, _pubProvisional: true })
    expect(file.sources[0]!._pubAttachments?.[0]?.kind).toBe('capture')
  } finally {
    await new Promise<void>((resolve) => pageServer.close(() => resolve()))
  }
})

test('the task buttons offer what can run, and a task names the open document to the model', async () => {
  const agent = await startAgentServer([{ text: 'Nothing to fix.' }])
  baseUrl = agent.url
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useAgent()
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'Assistant'))

  // Opening an empty project lands the writer on a fresh page, so the
  // document-scoped buttons are already on offer. Close that tab the way a
  // writer would to reach the state with nothing open. `ensureDocumentOpen`
  // lands that page on a delay, so wait for it: a close that runs first
  // removes nothing, and the page then arrives under the assertions.
  await harness.page.waitForFunction(() =>
    window.__pub.layout.getState().api?.panels.some((panel) => panel.id.startsWith('editor:'))
  )
  await harness.page.evaluate(() => {
    const api = window.__pub.layout.getState().api!
    for (const panel of api.panels.filter((candidate) => candidate.id.startsWith('editor:'))) {
      api.removePanel(panel)
    }
  })
  await harness.page.waitForFunction(() => window.__pub.documents.getState().activeDocId === null)

  // No document open: only the project-wide asks.
  const tasks = harness.page.getByTestId('assistant-tasks')
  await expect(tasks.getByTestId('task-prompt')).toBeVisible()
  await expect(tasks.getByTestId('task-peer-review')).toHaveCount(0)
  await expect(tasks.getByTestId('task-research')).toHaveCount(0)

  const docId = await createDocument(harness.page, 'scene.pubdoc')
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'Assistant'))
  await expect(tasks.getByTestId('task-peer-review')).toBeVisible()
  await expect(tasks.getByTestId('task-proofread')).toBeVisible()

  await tasks.getByTestId('task-proofread').click()
  await expect(harness.page.getByTestId('chat-assistant').last()).toContainText('Nothing to fix.')
  const sent = agent.requests()[0] as { messages: { role: string; content: string }[] }
  const asked = sent.messages.filter((message) => message.role === 'user').at(-1)!.content
  expect(asked).toContain('scene.pubdoc')
  expect(asked).toContain('proofread')
  // The project brief rides in the system prompt, naming the project.
  expect(sent.messages[0]!.role).toBe('system')
  expect(sent.messages[0]!.content).toContain('The project is')
  void docId
})
