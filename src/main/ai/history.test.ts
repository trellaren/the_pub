import { describe, it, expect } from 'vitest'
import { historyToOutbound } from './history.js'
import { buildRequest } from './providers.js'
import { aiSettingsSchema, resolveSettings, type ChatMessage } from '../../shared/model/ai.js'

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'text'>): ChatMessage {
  return { id: 'm', model: '', toolCalls: [], created: '2026-10-02T00:00:00.000Z', ...partial }
}

const transcript: ChatMessage[] = [
  message({ id: 'u1', role: 'user', text: 'Where is the harbour?' }),
  message({
    id: 'a1',
    role: 'assistant',
    text: 'In chapter one.',
    toolCalls: [
      {
        id: 'call_1',
        name: 'search_manuscript',
        args: '{"query":"harbour"}',
        result: 'Searched for "harbour" — 1 passage',
        content: 'ch1.pubdoc (block 2): the harbour at dusk',
        ok: true
      }
    ]
  }),
  message({ id: 'u2', role: 'user', text: 'Quote it.' })
]

describe('historyToOutbound', () => {
  it('replays a tool call as the call-then-result pair the model expects', () => {
    const outbound = historyToOutbound(transcript)
    expect(outbound).toEqual([
      { role: 'user', text: 'Where is the harbour?' },
      {
        role: 'assistant',
        text: 'In chapter one.',
        toolCalls: [{ id: 'call_1', name: 'search_manuscript', args: '{"query":"harbour"}' }]
      },
      { role: 'user', text: '', toolResults: [{ id: 'call_1', content: 'ch1.pubdoc (block 2): the harbour at dusk' }] },
      { role: 'user', text: 'Quote it.' }
    ])
  })

  it('falls back to the summary for messages recorded before results were kept', () => {
    const old = { ...transcript[1]!, toolCalls: [{ ...transcript[1]!.toolCalls[0]!, content: '' }] }
    const outbound = historyToOutbound([old])
    expect(outbound[1]!.toolResults![0]!.content).toBe('Searched for "harbour" — 1 passage')
  })

  it('does not replay a pairing for a failure the renderer recorded locally', () => {
    const failed = message({ id: 'error-req', role: 'assistant', text: '⚠ boom', toolCalls: [] })
    expect(historyToOutbound([failed])).toEqual([{ role: 'assistant', text: '⚠ boom' }])
  })

  it('serialises for both dialects, with the result turn kept separate from the next question', () => {
    const outbound = historyToOutbound(transcript)

    const anthropic = resolveSettings(aiSettingsSchema.parse({ provider: 'anthropic' }))
    const a = JSON.parse(buildRequest({ settings: anthropic, system: '', messages: outbound, apiKey: 'k' }).init.body)
    expect(a.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
    expect(a.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' })

    const openai = resolveSettings(aiSettingsSchema.parse({ provider: 'openai' }))
    const o = JSON.parse(buildRequest({ settings: openai, system: '', messages: outbound, apiKey: 'k' }).init.body)
    expect(o.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(o.messages[2]).toMatchObject({ tool_call_id: 'call_1' })
  })
})
