import { describe, it, expect } from 'vitest'
import {
  normalizeMessages,
  buildRequest,
  SseParser,
  deltaFrom,
  errorMessage,
  modelsUrl,
  parseModelList,
  type OutboundMessage
} from './providers.js'
import { aiSettingsSchema, resolveSettings, type AiProviderId } from '../../shared/model/ai.js'

function settingsFor(provider: AiProviderId, overrides = {}) {
  return resolveSettings(aiSettingsSchema.parse({ provider, ...overrides }))
}

const conversation: OutboundMessage[] = [
  { role: 'user', text: 'Read this scene.' },
  { role: 'assistant', text: 'It opens well.' }
]

describe('normalizeMessages', () => {
  it('merges consecutive messages from the same role', () => {
    // A failed send easily leaves two user messages in a row, which a strict
    // API rejects outright.
    expect(
      normalizeMessages([
        { role: 'user', text: 'One' },
        { role: 'user', text: 'Two' }
      ])
    ).toEqual([{ role: 'user', text: 'One\n\nTwo' }])
  })

  it('drops leading assistant messages', () => {
    expect(
      normalizeMessages([
        { role: 'assistant', text: 'Hello' },
        { role: 'user', text: 'Hi' }
      ])
    ).toEqual([{ role: 'user', text: 'Hi' }])
  })

  it('drops empty messages', () => {
    expect(normalizeMessages([{ role: 'user', text: '   ' }])).toEqual([])
  })

  it('leaves a well-formed conversation alone', () => {
    expect(normalizeMessages(conversation)).toEqual(conversation)
  })
})

describe('buildRequest', () => {
  it('sends Anthropic its own message shape and system field', () => {
    const built = buildRequest({
      settings: settingsFor('anthropic'),
      system: 'You are an editor.',
      messages: conversation,
      apiKey: 'sk-test'
    })
    expect(built.url).toBe('https://api.anthropic.com/v1/messages')
    expect(built.init.headers['x-api-key']).toBe('sk-test')
    expect(built.init.headers['anthropic-version']).toBe('2023-06-01')

    const body = JSON.parse(built.init.body) as Record<string, unknown>
    expect(body.system).toBe('You are an editor.')
    expect(body.stream).toBe(true)
    // The system prompt is a field, never a message.
    expect(body.messages).toEqual([
      { role: 'user', content: 'Read this scene.' },
      { role: 'assistant', content: 'It opens well.' }
    ])
  })

  it('sends the OpenAI dialect for OpenAI, Hugging Face and LM Studio alike', () => {
    for (const provider of ['openai', 'huggingface', 'lmstudio'] as const) {
      const built = buildRequest({
        settings: settingsFor(provider),
        system: 'Be brief.',
        messages: conversation,
        apiKey: 'key'
      })
      expect(built.url.endsWith('/v1/chat/completions')).toBe(true)
      expect(built.init.headers.authorization).toBe('Bearer key')
      const body = JSON.parse(built.init.body) as { messages: { role: string }[] }
      // Here the system prompt *is* a message, and comes first.
      expect(body.messages[0]).toEqual({ role: 'system', content: 'Be brief.' })
    }
  })

  it('sends no auth header when there is no key', () => {
    const built = buildRequest({
      settings: settingsFor('lmstudio'),
      system: '',
      messages: conversation,
      apiKey: null
    })
    expect(built.init.headers.authorization).toBeUndefined()
    expect(built.url.startsWith('http://127.0.0.1:1234')).toBe(true)
  })

  it('honours a base url override and trims its trailing slash', () => {
    const built = buildRequest({
      settings: settingsFor('lmstudio', { baseUrl: 'http://localhost:9999/' }),
      system: '',
      messages: conversation,
      apiKey: null
    })
    expect(built.url).toBe('http://localhost:9999/v1/chat/completions')
  })

  it('omits an empty system prompt rather than sending a blank one', () => {
    const anthropic = JSON.parse(
      buildRequest({ settings: settingsFor('anthropic'), system: '  ', messages: conversation, apiKey: 'k' })
        .init.body
    ) as Record<string, unknown>
    expect(anthropic.system).toBeUndefined()

    const openai = JSON.parse(
      buildRequest({ settings: settingsFor('openai'), system: '', messages: conversation, apiKey: 'k' })
        .init.body
    ) as { messages: { role: string }[] }
    expect(openai.messages[0]!.role).toBe('user')
  })
})

describe('SseParser', () => {
  it('reads whole events out of one chunk', () => {
    const parser = new SseParser()
    expect(parser.push('data: a\ndata: b\n')).toEqual(['a', 'b'])
  })

  it('holds a half-received event until the rest arrives', () => {
    // A network read has no relationship to an event boundary; this is the case
    // that silently drops text when it is got wrong.
    const parser = new SseParser()
    expect(parser.push('data: {"par')).toEqual([])
    expect(parser.push('tial": true}\n')).toEqual(['{"partial": true}'])
  })

  it('ignores blank lines, comments and non-data fields', () => {
    const parser = new SseParser()
    expect(parser.push('\n: ping\nevent: message\ndata: real\n')).toEqual(['real'])
  })

  it('handles carriage returns from a proxy that rewrites line endings', () => {
    const parser = new SseParser()
    expect(parser.push('data: one\r\ndata: two\r\n')).toEqual(['one', 'two'])
  })

  it('returns a final event that arrived without its newline', () => {
    const parser = new SseParser()
    expect(parser.push('data: last')).toEqual([])
    expect(parser.flush()).toEqual(['last'])
    expect(parser.flush()).toEqual([])
  })
})

describe('deltaFrom', () => {
  it('reads Anthropic text deltas and ignores its other events', () => {
    expect(
      deltaFrom('anthropic', JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }))
    ).toBe('Hi')
    expect(deltaFrom('anthropic', JSON.stringify({ type: 'message_start' }))).toBeNull()
    expect(deltaFrom('anthropic', JSON.stringify({ type: 'ping' }))).toBeNull()
  })

  it('reads OpenAI-style deltas', () => {
    expect(deltaFrom('openai', JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }))).toBe('Hi')
    // The first event announces the role and carries no text.
    expect(deltaFrom('openai', JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }))).toBeNull()
    expect(deltaFrom('openai', JSON.stringify({ choices: [{ delta: { content: null } }] }))).toBeNull()
  })

  it('treats the done sentinel as no text', () => {
    expect(deltaFrom('openai', '[DONE]')).toBeNull()
  })

  it('survives a malformed event rather than failing the reply', () => {
    expect(deltaFrom('openai', '{not json')).toBeNull()
  })
})

describe('errorMessage', () => {
  it('digs the message out of either shape', () => {
    expect(errorMessage(401, JSON.stringify({ error: { message: 'Invalid key' } }))).toBe('401: Invalid key')
    expect(errorMessage(400, JSON.stringify({ error: 'Bad model' }))).toBe('400: Bad model')
    expect(errorMessage(500, JSON.stringify({ message: 'Server error' }))).toBe('500: Server error')
  })

  it('falls back to the raw body, truncated', () => {
    expect(errorMessage(502, '<html>gateway</html>')).toContain('502:')
    expect(errorMessage(500, 'x'.repeat(1000)).length).toBeLessThan(320)
  })

  it('says something useful for an empty body', () => {
    expect(errorMessage(503, '')).toBe('Request failed with status 503')
  })
})

describe('model listing', () => {
  it('only asks providers that can answer', () => {
    expect(modelsUrl(settingsFor('openai'))).toBe('https://api.openai.com/v1/models')
    expect(modelsUrl(settingsFor('lmstudio'))).toBe('http://127.0.0.1:1234/v1/models')
    expect(modelsUrl(settingsFor('anthropic'))).toBeNull()
    expect(modelsUrl(settingsFor('huggingface'))).toBeNull()
  })

  it('reads and sorts a model list, ignoring junk', () => {
    expect(parseModelList({ data: [{ id: 'b' }, { id: 'a' }, { nope: 1 }] })).toEqual(['a', 'b'])
    expect(parseModelList({})).toEqual([])
    expect(parseModelList(null)).toEqual([])
  })
})
