import type { AiProviderId, AiSettings } from '../../shared/model/ai.js'

export interface OutboundMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface ProviderRequest {
  settings: AiSettings
  system: string
  messages: OutboundMessage[]
  apiKey: string | null
}

export interface BuiltRequest {
  url: string
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
  }
}

/**
 * Every provider is HTTP with a streamed body, so the differences worth
 * abstracting are small: which URL, which auth header, which shape of JSON, and
 * how a delta is dug out of an event. Everything above this — chats, context,
 * cancellation, the panel — is identical for all four.
 */

/**
 * Make a conversation acceptable to a strict API.
 *
 * Anthropic rejects consecutive messages with the same role and a conversation
 * that opens with the assistant. Both are easy to produce here: a failed send
 * can leave a trailing user message, and "continue from this" starts with
 * assistant text. Normalising once, for every provider, means no provider-
 * specific bug reports about message order.
 */
export function normalizeMessages(messages: readonly OutboundMessage[]): OutboundMessage[] {
  const kept = messages.filter((message) => message.text.trim().length > 0)
  const leading = kept.findIndex((message) => message.role === 'user')
  const fromUser = leading === -1 ? [] : kept.slice(leading)

  const merged: OutboundMessage[] = []
  for (const message of fromUser) {
    const last = merged[merged.length - 1]
    if (last && last.role === message.role) {
      merged[merged.length - 1] = { role: last.role, text: `${last.text}\n\n${message.text}` }
      continue
    }
    merged.push({ ...message })
  }
  return merged
}

export function buildRequest(request: ProviderRequest): BuiltRequest {
  const { settings, apiKey } = request
  const messages = normalizeMessages(request.messages)
  const system = request.system.trim()

  if (settings.provider === 'anthropic') {
    return {
      url: `${settings.baseUrl}/v1/messages`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(apiKey ? { 'x-api-key': apiKey } : {})
        },
        body: JSON.stringify({
          model: settings.model,
          max_tokens: settings.maxTokens,
          temperature: settings.temperature,
          // Anthropic takes the system prompt as its own field, not a message.
          ...(system ? { system } : {}),
          messages: messages.map((message) => ({ role: message.role, content: message.text })),
          stream: true
        })
      }
    }
  }

  // OpenAI, Hugging Face's router and LM Studio all speak the same dialect, so
  // one branch covers three providers rather than three near-identical ones.
  return {
    url: `${settings.baseUrl}/v1/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...messages.map((message) => ({ role: message.role, content: message.text }))
        ],
        stream: true
      })
    }
  }
}

/**
 * Turn a byte stream into server-sent event payloads.
 *
 * A network chunk has no relationship to an event boundary: one read can carry
 * three events and half of a fourth. Holding the remainder until its newline
 * arrives is the whole job, and getting it wrong produces a parser that works
 * on a fast local model and drops text from a slow remote one.
 */
export class SseParser {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const payloads: string[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      const payload = dataOf(line)
      if (payload !== null) payloads.push(payload)
      newline = this.buffer.indexOf('\n')
    }
    return payloads
  }

  /** Anything left when the stream ends without a final newline. */
  flush(): string[] {
    const rest = dataOf(this.buffer.trim())
    this.buffer = ''
    return rest === null ? [] : [rest]
  }
}

function dataOf(line: string): string | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  return payload.length > 0 ? payload : null
}

/**
 * The text carried by one event payload, or null for the many events that
 * carry none — pings, role announcements, usage, and the `[DONE]` sentinel.
 */
export function deltaFrom(provider: AiProviderId, payload: string): string | null {
  if (payload === '[DONE]') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    // A malformed event is not worth failing a whole reply over.
    return null
  }

  if (provider === 'anthropic') {
    const event = parsed as { type?: string; delta?: { type?: string; text?: string } }
    if (event.type !== 'content_block_delta') return null
    return typeof event.delta?.text === 'string' ? event.delta.text : null
  }

  const event = parsed as { choices?: { delta?: { content?: string | null } }[] }
  const content = event.choices?.[0]?.delta?.content
  return typeof content === 'string' && content.length > 0 ? content : null
}

/** An error body's message, whichever shape the provider used to say it. */
export function errorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string
      message?: string
    }
    const fromError =
      typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
    if (fromError) return `${status}: ${fromError}`
  } catch {
    // Not JSON — fall through to the raw body.
  }
  const trimmed = body.trim()
  return trimmed ? `${status}: ${trimmed.slice(0, 300)}` : `Request failed with status ${status}`
}

/** Where to ask a provider what models it has. Null when it cannot be asked. */
export function modelsUrl(settings: AiSettings): string | null {
  switch (settings.provider) {
    case 'openai':
    case 'lmstudio':
      return `${settings.baseUrl}/v1/models`
    // Anthropic and the Hugging Face router have no list endpoint worth using
    // here, so their models are typed in rather than picked.
    default:
      return null
  }
}

export function parseModelList(body: unknown): string[] {
  const parsed = body as { data?: { id?: unknown }[] }
  if (!Array.isArray(parsed?.data)) return []
  return parsed.data
    .map((item) => item?.id)
    .filter((id): id is string => typeof id === 'string')
    .sort()
}
