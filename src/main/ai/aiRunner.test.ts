import { describe, it, expect, vi, afterEach } from 'vitest'
import { streamCompletion } from './aiRunner.js'
import { partsFrom } from './providers.js'
import { aiSettingsSchema, type AiProviderId } from '../../shared/model/ai.js'

function sseBody(events: unknown[]): ReadableStream<Uint8Array> {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })
}

function serve(events: unknown[]): void {
  vi.stubGlobal('fetch', async () => new Response(sseBody(events), { status: 200 }))
}

function request(provider: AiProviderId) {
  return {
    settings: aiSettingsSchema.parse({ provider, model: 'stub', baseUrl: 'http://127.0.0.1:1' }),
    system: '',
    messages: [{ role: 'user' as const, text: 'Hello' }],
    apiKey: 'key'
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('streamCompletion', () => {
  it('reports an Anthropic error event as a failure, keeping the partial text', async () => {
    serve([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The harbour' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
    ])
    const outcome = await streamCompletion(request('anthropic'), new AbortController().signal, () => {})
    expect(outcome.error).toBe('Overloaded')
    expect(outcome.text).toBe('The harbour')
  })

  it('completes normally when no error event arrives', async () => {
    serve([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }, { type: 'message_stop' }])
    const outcome = await streamCompletion(request('anthropic'), new AbortController().signal, () => {})
    expect(outcome.error).toBeNull()
    expect(outcome.text).toBe('Done.')
  })

  it('reports an error object in an OpenAI-style stream too', async () => {
    serve([{ choices: [{ delta: { content: 'Half' } }] }, { error: { message: 'context length exceeded' } }])
    const outcome = await streamCompletion(request('openai'), new AbortController().signal, () => {})
    expect(outcome.error).toBe('context length exceeded')
  })
})

describe('partsFrom error events', () => {
  it('falls back to the error type when there is no message', () => {
    expect(partsFrom('anthropic', JSON.stringify({ type: 'error', error: { type: 'api_error' } }))).toEqual([
      { kind: 'error', message: 'api_error' }
    ])
  })
})
