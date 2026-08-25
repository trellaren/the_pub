import { test, expect } from '@playwright/test'
import http from 'node:http'
import path from 'node:path'
import { launch, openProject, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { EntityFile } from '../src/shared/model/entity.js'

let harness: Harness
let server: http.Server | null = null
let baseUrl = ''

/**
 * What only the real app can show about drafting.
 *
 * The constraint arithmetic is unit-tested, and so are the refusals. What is
 * left is the part this repo has learned to distrust: that a record the
 * assistant wrote appears in the panel without a reopen, that accepting and
 * discarding are what they say they are, and that both survive the project
 * closing — a provisional flag that quietly reverts on reload would hand the
 * writer back an accept button for work they already accepted.
 */
type Turn = { text?: string; call?: { name: string; args: unknown } }
interface Request {
  messages: { role: string; content?: unknown }[]
}

/** Whether this request is the loop feeding a tool's result back — i.e. the run is finishing. */
function answering(body: Request): boolean {
  return body.messages.some((message) => message.role === 'tool')
}

/** The last thing a person asked, so one server can serve two runs in a conversation. */
function asked(body: Request): string {
  const user = body.messages.filter(
    (message) => message.role === 'user' && typeof message.content === 'string' && message.content
  )
  return String(user.at(-1)?.content ?? '')
}

/*
 * Answers each request on its merits rather than reading down a script. A
 * scripted stub is consumed by the *loop* — the first run spends the second
 * run's turn on its own second step — which is a test that quietly proves
 * something other than what it says.
 */
async function startAgentServer(respond: (body: Request) => Turn): Promise<{ url: string }> {
  let step = 0

  server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const turn = respond(JSON.parse(body || '{"messages":[]}') as Request)
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
  return { url: `http://127.0.0.1:${address.port}` }
}

test.afterEach(async () => {
  if (harness) await cleanup(harness)
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

function entitiesFile(dir = harness.projectDir): string {
  return path.join(dir, '.thepub', 'entities.json')
}

async function useAgent(): Promise<void> {
  await harness.page.evaluate((url) => {
    return window.__pub.chats.getState().saveSettings({
      provider: 'lmstudio',
      model: 'stub-model',
      baseUrl: url,
      temperature: 0.7,
      maxTokens: 512,
      systemPrompt: '',
      agent: true,
      embedModel: ''
    })
  }, baseUrl)
}

async function showRecords(): Promise<void> {
  await harness.page.evaluate(() =>
    window.__pub.layout
      .getState()
      .showPanel('records', 'Characters', { panelId: 'character', params: { kind: 'character' } })
  )
}

const ENSEMBLE = {
  kind: 'character',
  premise: "a ship's crew",
  constraints: { exactlyOne: ['lying about why they signed on'] },
  records: [
    {
      name: 'Aurelio',
      summary: 'A dockworker with a debt.',
      properties: { 'lying about why they signed on': 'yes' }
    },
    {
      name: 'Benedita',
      summary: 'A cook who has been to sea before.',
      properties: { 'lying about why they signed on': 'no' }
    }
  ]
}

test('an ensemble is drafted, accepted and discarded, and both outcomes survive a reopen', async () => {
  const agent = await startAgentServer((body) =>
    answering(body) ? { text: 'Two of them, one lying.' } : { call: { name: 'draft_ensemble', args: ENSEMBLE } }
  )
  baseUrl = agent.url

  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useAgent()
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
  await showRecords()

  await harness.page.evaluate(() =>
    window.__pub.chats.getState().ask("Draft me a ship's crew of two.")
  )

  // The panel is told the moment the tool call lands. A drafted cast that only
  // appeared on reopen is one the writer would assume had failed.
  await expect(harness.page.getByTestId('entity-draft-badge')).toHaveCount(2)

  // Both are real records in the real file, which is what lets the writer
  // search, mention and link them while deciding.
  const drafted = await readJson<EntityFile>(entitiesFile())
  expect(drafted.entities.map((entity) => entity.name).sort()).toEqual(['Aurelio', 'Benedita'])
  expect(drafted.entities.every((entity) => entity.provisional)).toBe(true)
  // The constraint the group was judged on is readable on the card.
  expect(drafted.entities[0]!.fields).toContainEqual({
    label: 'lying about why they signed on',
    value: 'yes'
  })

  await harness.page.getByTestId('character-list').getByText('Aurelio').click()
  await expect(harness.page.getByTestId('entity-provisional')).toBeVisible()
  await harness.page.getByTestId('entity-accept').click()
  await expect(harness.page.getByTestId('entity-provisional')).toHaveCount(0)

  await harness.page.getByTestId('character-list').getByText('Benedita').click()
  await harness.page.getByTestId('entity-discard').click()
  await expect(harness.page.getByTestId('entity-draft-badge')).toHaveCount(0)

  await waitFor(async () => {
    const file = await readJson<EntityFile>(entitiesFile())
    return file.entities.length === 1 && file.entities[0]!.provisional === false
  }, 'the accept and the discard to reach entities.json')

  const { projectDir, userDataDir } = harness
  await harness.app.close()
  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)
  await showRecords()

  // The accepted one is the writer's, with nothing left to accept; the
  // discarded one is gone. Neither is a state that can revert on reload.
  await expect(harness.page.getByTestId('character-list')).toContainText('Aurelio')
  await expect(harness.page.getByTestId('character-list')).not.toContainText('Benedita')
  await expect(harness.page.getByTestId('entity-draft-badge')).toHaveCount(0)
  await harness.page.getByTestId('character-list').getByText('Aurelio').click()
  await expect(harness.page.getByTestId('entity-provisional')).toHaveCount(0)
})

test('a record the writer has accepted is out of the assistant\'s reach', async () => {
  const agent = await startAgentServer((body) => {
    if (answering(body)) return { text: 'Done.' }
    return asked(body).includes('rewrite')
      ? { call: { name: 'revise_record', args: { name: 'Aurelio', summary: 'Something else entirely.' } } }
      : {
          call: {
            name: 'draft_record',
            args: { kind: 'character', name: 'Aurelio', summary: 'A dockworker.' }
          }
        }
  })
  baseUrl = agent.url

  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await useAgent()
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
  await showRecords()

  await harness.page.evaluate(() => window.__pub.chats.getState().ask('Draft me a dockworker.'))
  await expect(harness.page.getByTestId('entity-draft-badge')).toHaveCount(1)

  await harness.page.getByTestId('character-list').getByText('Aurelio').click()
  await harness.page.getByTestId('entity-accept').click()
  await expect(harness.page.getByTestId('entity-provisional')).toHaveCount(0)

  await harness.page.evaluate(() => window.__pub.chats.getState().ask('Now rewrite Aurelio.'))

  /*
   * The refusal a person can see: the run happened, the tool was called, and
   * the record did not change. This is the failure the whole phase is built to
   * prevent — a model tidying a character the writer spent an afternoon on.
   */
  await expect(harness.page.getByTestId('tool-trail').last()).toContainText('Refused to revise')
  const file = await readJson<EntityFile>(entitiesFile())
  expect(file.entities[0]!.summary).toBe('A dockworker.')
})

test('with AI off there is nothing to draft with', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() => window.pub.invoke('app:setAiEnabled', { enabled: false }))
  await showRecords()

  // Removed rather than left in the panel refusing: a greyed-out "draft with
  // the assistant" is still an AI product.
  await expect(harness.page.getByTestId('character-draft')).toHaveCount(0)
  await expect(harness.page.getByTestId('character-ensemble')).toHaveCount(0)

  // And the way in is closed behind the panel too, not only in front of it.
  const refused = await harness.page.evaluate(async () => {
    const chat = await window.__pub.chats.getState().createChat('x')
    try {
      await window.pub.invoke('ai:send', { chatId: chat!.id, text: 'Draft me a crew.', context: '' })
      return null
    } catch (error) {
      return String(error)
    }
  })
  expect(refused).toContain('turned off')
})

test('drafting is offered only when the writer has turned the agent on', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await showRecords()

  // AI is on but this is an ordinary chat, which has no tools at all. Offering
  // to draft would be offering something that cannot happen.
  await expect(harness.page.getByTestId('character-ensemble')).toHaveCount(0)

  baseUrl = 'http://127.0.0.1:1'
  await useAgent()
  await expect(harness.page.getByTestId('character-ensemble')).toBeVisible()
})
