import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StreamEvent } from '../../shared/model/ai.js'
import { aiSettingsSchema, resolveSettings } from '../../shared/model/ai.js'
import { AiRunner } from './aiRunner.js'
import { runAgent, MAX_STEPS, MAX_TOOL_CALLS_PER_STEP, MAX_NESTED_COMPLETIONS, MAX_TOOL_RESULT_CHARS } from './agentRunner.js'
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
type Call = { id: string; name: string; args: string }
type Turn = { text?: string; call?: Call; calls?: Call[] }

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
    const calls = turn.calls ?? (turn.call ? [turn.call] : [])
    if (calls.length) {
      events.push(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: calls.map((call, index) => ({
                  index,
                  id: call.id,
                  function: { name: call.name, arguments: call.args }
                }))
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
          docId: 'doc-1',
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
    reviews: {
      createThread: async () => ({ id: 'thread-1' }),
      list: async () => [],
      reply: async () => ({ id: 'reply-1' })
    },
    manifest: { publication: { language: 'en-GB' } },
    beats: { snapshot: () => ({ beats: [], columns: [] }) },
    ...overrides
  } as unknown as ProjectSession
}

const settings = resolveSettings(aiSettingsSchema.parse({ provider: 'lmstudio' }))
const assistant = { id: 'assistant-owner', name: 'Assistant', color: '' }

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
    assistant,
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

  it('describes a suggested edit in block offsets instead of writing to the document', async () => {
    const { events } = await run([
      {
        call: {
          id: 'call_1',
          name: 'suggest_edit',
          args: JSON.stringify({
            path: 'ch1.pubdoc',
            find: 'at dusk was quiet',
            replace: 'lay quiet at dusk',
            reason: 'Tighter.'
          })
        }
      },
      { text: 'Suggested a tightening.' }
    ])

    const edit = events.find((event) => event.type === 'edit')
    expect(edit?.type === 'edit' && edit.edit).toMatchObject({
      docPath: 'ch1.pubdoc',
      docId: 'doc-1',
      authorId: 'assistant-owner',
      runId: 'req-1',
      mode: 'suggest',
      ops: [{ kind: 'replace', blockIndex: 0, start: 12, end: 29, text: 'lay quiet at dusk', reason: 'Tighter.' }]
    })
  })

  it('keeps what the model saw on the record, so the next turn can replay it', async () => {
    const { events } = await run([
      { call: { id: 'call_1', name: 'search_manuscript', args: '{"query":"harbour"}' } },
      { text: 'Chapter one.' }
    ])
    const done = events.find((event) => event.type === 'done')
    expect(done?.type === 'done' && done.message.toolCalls[0]!.content).toContain('the harbour at dusk')
  })

  it('refuses a suggestion quoting text the document does not contain', async () => {
    const { events } = await run([
      {
        call: {
          id: 'call_1',
          name: 'suggest_edit',
          args: JSON.stringify({ path: 'ch1.pubdoc', find: 'nowhere in the book', replace: 'x' })
        }
      },
      { text: 'I could not find that line.' }
    ])

    // Discovering an unplaceable suggestion after the author has read it is
    // discovering it too late.
    expect(events.some((event) => event.type === 'edit')).toBe(false)
    const tool = events.find((event) => event.type === 'tool')
    expect(tool?.type === 'tool' && tool.call.ok).toBe(false)
  })

  it('lets a tool ask the model a plain question of its own, under the same cancel signal', async () => {
    // Turn two is the nested proofreading reply, not a tool turn: it carries
    // no tools and is answered in JSON, which the tool then places.
    const { events, bodies } = await run([
      { call: { id: 'call_1', name: 'proofread', args: JSON.stringify({ path: 'ch1.pubdoc' }) } },
      { text: JSON.stringify([{ block: 0, find: 'at dusk', replace: 'at dawn', kind: 'style' }]) },
      { text: 'Done.' }
    ])

    expect(bodies).toHaveLength(3)
    expect(bodies[1]!.tools).toBeUndefined()
    const edit = events.find((event) => event.type === 'edit')
    expect(edit?.type === 'edit' && edit.edit.ops).toEqual([
      { kind: 'replace', blockIndex: 0, start: 12, end: 19, text: 'at dawn', reason: 'style' }
    ])
    const done = events.find((event) => event.type === 'done')
    expect(done?.type === 'done' && done.message.toolCalls[0]!.result).toContain('1 suggestion')
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
      assistant,
      onEvent: (event) => events.push(event)
    })

    expect(events.at(-1)).toMatchObject({ type: 'error' })
  })

  it('answers every call past the per-step cap with a refusal instead of running it', async () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_STEP + 2 }, (_, index) => ({
      id: `call_${index}`,
      name: 'search_manuscript',
      args: '{"query":"harbour"}'
    }))
    const query = vi.fn(() => [{ path: 'ch1.pubdoc', blockIndex: 2, snippet: 'the harbour at dusk' }])
    const { bodies } = await run([{ calls }, { text: 'Done.' }], fakeSession({ search: { query } }))

    expect(query).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_STEP)
    const answers = (bodies[1]!.messages as { role: string; tool_call_id?: string; content?: string }[]).filter(
      (message) => message.role === 'tool'
    )
    expect(answers).toHaveLength(calls.length)
    expect(answers.at(-1)!.content).toContain('Make fewer calls')
  })

  it('clips a tool result before it goes back to the model', async () => {
    const huge = 'harbour '.repeat(5_000)
    const { bodies } = await run(
      [{ call: { id: 'call_1', name: 'search_manuscript', args: '{"query":"harbour"}' } }, { text: 'Done.' }],
      fakeSession({ search: { query: () => [{ path: 'ch1.pubdoc', blockIndex: 0, snippet: huge }] } })
    )
    const answer = (bodies[1]!.messages as { role: string; content?: string }[]).find((message) => message.role === 'tool')!
    expect(answer.content!.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 100)
    expect(answer.content).toContain('[…truncated…]')
  })

  it('stops tools asking the model questions once the run has spent its budget', async () => {
    let toolSteps = 0
    let nested = 0
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown }
      let event: unknown
      if (!body.tools) {
        nested += 1
        event = { choices: [{ delta: { content: '[]' } }] }
      } else if (toolSteps < 6) {
        toolSteps += 1
        event = {
          choices: [
            {
              delta: {
                tool_calls: Array.from({ length: MAX_TOOL_CALLS_PER_STEP }, (_, index) => ({
                  index,
                  id: `call_${toolSteps}_${index}`,
                  function: { name: 'proofread', arguments: '{"path":"ch1.pubdoc"}' }
                }))
              }
            }
          ]
        }
      } else {
        event = { choices: [{ delta: { content: 'Done.' } }] }
      }
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`))
            controller.close()
          }
        })
      } as unknown as Response
    }) as unknown as typeof globalThis.fetch

    const events: StreamEvent[] = []
    await runAgent(new AiRunner(), {
      requestId: 'req-1',
      settings,
      system: '',
      messages: [{ role: 'user', text: 'Proofread it, again and again.' }],
      apiKey: null,
      session: fakeSession(),
      assistant,
      onEvent: (event) => events.push(event)
    })

    expect(nested).toBe(MAX_NESTED_COMPLETIONS)
    const refused = events.filter((event) => event.type === 'tool' && !event.call.ok)
    expect(refused.length).toBeGreaterThan(0)
    expect(refused[0]!.type === 'tool' && refused[0]!.call.content).toContain('model calls for tools')
  })
})
