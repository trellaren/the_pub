import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StreamEvent } from '../../shared/model/ai.js'
import { aiSettingsSchema, resolveSettings } from '../../shared/model/ai.js'
import { AiRunner } from './aiRunner.js'
import { runAgent, MAX_STEPS } from './agentRunner.js'
import { toolSpecs } from './tools.js'
import type { ProjectSession } from '../services/projectSession.js'

/**
 * A provider that replies with a scripted sequence of turns.
 *
 * Driving the loop through `fetch` rather than through a mocked
 * `streamCompletion` is deliberate: the request shape, the SSE framing and the
 * tool-call parsing are exactly the parts most likely to break, and a mock one
 * level up would step over all three.
 */
type Turn = { text?: string; call?: { id: string; name: string; args: string } }

function scripted(turns: Turn[]): { fetch: typeof globalThis.fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  let step = 0

  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    const turn = turns[Math.min(step, turns.length - 1)]!
    step += 1

    const events: string[] = []
    if (turn.text) {
      events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.text } }] })}\n`)
    }
    if (turn.call) {
      events.push(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: turn.call.id,
                    function: { name: turn.call.name, arguments: turn.call.args }
                  }
                ]
              }
            }
          ]
        })}\n`
      )
    }
    events.push('data: [DONE]\n')

    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(new TextEncoder().encode(event))
          controller.close()
        }
      })
    } as unknown as Response
  }) as unknown as typeof globalThis.fetch

  return { fetch: fetchImpl, bodies }
}

/** Only the handful of services the tools actually reach. */
function fakeSession(overrides: Partial<Record<string, unknown>> = {}): ProjectSession {
  return {
    search: { query: () => [{ path: 'ch1.pubdoc', blockIndex: 2, snippet: 'the harbour at dusk' }] },
    documents: {
      read: async () => ({
        doc: {
          title: 'Chapter One',
          content: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'The harbour at dusk was quiet.' }] }
            ]
          }
        }
      })
    },
    entities: { snapshot: () => ({ entities: [] }) },
    manuscript: { view: async () => ({ nodes: [], resolving: false }) },
    ...overrides
  } as unknown as ProjectSession
}

const settings = resolveSettings(aiSettingsSchema.parse({ provider: 'lmstudio', agent: true }))

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

async function run(
  turns: Turn[],
  session = fakeSession()
): Promise<{ events: StreamEvent[]; bodies: Record<string, unknown>[] }> {
  const script = scripted(turns)
  globalThis.fetch = script.fetch
  const events: StreamEvent[] = []

  await runAgent(new AiRunner(), {
    requestId: 'req-1',
    settings,
    system: '',
    messages: [{ role: 'user', text: 'Where do I describe the harbour?' }],
    apiKey: null,
    session,
    onEvent: (event) => events.push(event)
  })

  return { events, bodies: script.bodies }
}

describe('runAgent', () => {
  it('answers in one request when the model calls no tools', async () => {
    const { events, bodies } = await run([{ text: 'In chapter one.' }])

    expect(bodies).toHaveLength(1)
    const done = events.find((event) => event.type === 'done')
    expect(done).toMatchObject({ type: 'done' })
    expect(done?.type === 'done' && done.message.text).toBe('In chapter one.')
    // The common case costs exactly one request, which is the reason the loop
    // lives beside `AiRunner` rather than inside it.
    expect(done?.type === 'done' && done.message.toolCalls).toEqual([])
  })

  it('offers the tools it can actually run', async () => {
    const { bodies } = await run([{ text: 'Done.' }])
    const names = (bodies[0]!.tools as { function: { name: string } }[]).map((t) => t.function.name)

    expect(names).toEqual(toolSpecs().map((spec) => spec.name))
    expect(names).toContain('search_manuscript')
  })

  it('runs a tool, feeds the result back, and answers on the next pass', async () => {
    const { events, bodies } = await run([
      { call: { id: 'call_1', name: 'search_manuscript', args: '{"query":"harbour"}' } },
      { text: 'Chapter one, around the second paragraph.' }
    ])

    expect(bodies).toHaveLength(2)
    // The second request carries the assistant's call and the tool's answer, in
    // the dialect's own shapes — the pairing every provider validates.
    const messages = bodies[1]!.messages as { role: string; tool_call_id?: string }[]
    expect(messages.some((message) => message.role === 'assistant')).toBe(true)
    expect(messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_1')).toBe(true)

    const tool = events.find((event) => event.type === 'tool')
    expect(tool?.type === 'tool' && tool.call.name).toBe('search_manuscript')
    // Reported as it happens, so a long search is visible while it runs.
    expect(events.indexOf(tool!)).toBeLessThan(events.findIndex((event) => event.type === 'done'))
  })

  it('records what it did on the finished message', async () => {
    const { events } = await run([
      { call: { id: 'call_1', name: 'search_manuscript', args: '{"query":"harbour"}' } },
      { text: 'Chapter one.' }
    ])

    const done = events.find((event) => event.type === 'done')
    expect(done?.type === 'done' && done.message.toolCalls).toEqual([
      expect.objectContaining({ name: 'search_manuscript', ok: true })
    ])
  })

  it('emits a proposal instead of writing to the document', async () => {
    const { events } = await run([
      {
        call: {
          id: 'call_1',
          name: 'propose_edit',
          args: JSON.stringify({
            path: 'ch1.pubdoc',
            find: 'The harbour at dusk was quiet.',
            replace: 'The harbour lay quiet at dusk.',
            reason: 'Tighter.'
          })
        }
      },
      { text: 'Suggested a tightening.' }
    ])

    const proposal = events.find((event) => event.type === 'proposal')
    expect(proposal?.type === 'proposal' && proposal.proposal).toMatchObject({
      docPath: 'ch1.pubdoc',
      replace: 'The harbour lay quiet at dusk.'
    })
  })

  it('refuses a proposal quoting text the document does not contain', async () => {
    const { events } = await run([
      {
        call: {
          id: 'call_1',
          name: 'propose_edit',
          args: JSON.stringify({ path: 'ch1.pubdoc', find: 'nowhere in the book', replace: 'x' })
        }
      },
      { text: 'I could not find that line.' }
    ])

    // Discovering an unappliable proposal when the author clicks accept is
    // discovering it too late.
    expect(events.some((event) => event.type === 'proposal')).toBe(false)
    const tool = events.find((event) => event.type === 'tool')
    expect(tool?.type === 'tool' && tool.call.ok).toBe(false)
  })

  it('reports an unknown tool back to the model rather than ending the run', async () => {
    const { events, bodies } = await run([
      { call: { id: 'call_1', name: 'delete_everything', args: '{}' } },
      { text: 'Sorry, I cannot do that.' }
    ])

    expect(bodies).toHaveLength(2)
    const done = events.find((event) => event.type === 'done')
    expect(done?.type === 'done' && done.message.text).toBe('Sorry, I cannot do that.')
  })

  it('stops at the step budget and says so', async () => {
    // A model that keeps calling the same tool spends the author's money until
    // something stops it. This is that something.
    const { events, bodies } = await run([
      { call: { id: 'call_1', name: 'search_manuscript', args: '{"query":"x"}' } }
    ])

    expect(bodies).toHaveLength(MAX_STEPS)
    const done = events.find((event) => event.type === 'done')
    expect(done?.type === 'done' && done.message.text).toContain(`${MAX_STEPS} steps`)
  })

  it('surfaces a provider failure as an error rather than a silent stop', async () => {
    globalThis.fetch = (async () =>
      ({ ok: false, status: 500, text: async () => 'boom' }) as unknown as Response) as never
    const events: StreamEvent[] = []

    await runAgent(new AiRunner(), {
      requestId: 'req-1',
      settings,
      system: '',
      messages: [{ role: 'user', text: 'Hello' }],
      apiKey: null,
      session: fakeSession(),
      onEvent: (event) => events.push(event)
    })

    expect(events.at(-1)).toMatchObject({ type: 'error' })
  })
})
