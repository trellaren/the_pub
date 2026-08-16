import type { AiProviderId, AiSettings } from '../../shared/model/ai.js'

/** A tool call the model asked for, with its arguments as raw JSON text. */
export interface OutboundToolCall {
  id: string
  name: string
  args: string
}

/** What a tool returned, addressed back to the call that asked for it. */
export interface OutboundToolResult {
  id: string
  content: string
}

export interface OutboundMessage {
  role: 'user' | 'assistant'
  text: string
  /** Set on an assistant turn that called tools. */
  toolCalls?: OutboundToolCall[]
  /** Set on the turn that carries results back. */
  toolResults?: OutboundToolResult[]
}

/**
 * A tool, described once and serialised into whichever dialect is in use.
 *
 * `parameters` is JSON Schema, which is what both dialects want — Anthropic
 * calls it `input_schema` and OpenAI calls it `parameters`, and that naming is
 * the whole of the difference.
 */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ProviderRequest {
  settings: AiSettings
  system: string
  messages: OutboundMessage[]
  apiKey: string | null
  /** Absent or empty means an ordinary reply with no tool use offered. */
  tools?: ToolSpec[]
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
  // A turn carrying tool data is never empty even when its text is: an
  // assistant turn that only called a tool, and the turn that carries the
  // result back, are both load-bearing. Dropping either breaks the pairing the
  // next request is validated against.
  const kept = messages.filter((message) => message.text.trim().length > 0 || carriesTools(message))
  const leading = kept.findIndex((message) => message.role === 'user')
  const fromUser = leading === -1 ? [] : kept.slice(leading)

  const merged: OutboundMessage[] = []
  for (const message of fromUser) {
    const last = merged[merged.length - 1]
    // Same-role turns merge only when neither carries tool data. Concatenating
    // a tool result into an ordinary message would strip the id it is
    // addressed by, which every provider rejects.
    if (last && last.role === message.role && !carriesTools(last) && !carriesTools(message)) {
      merged[merged.length - 1] = { role: last.role, text: `${last.text}\n\n${message.text}` }
      continue
    }
    merged.push({ ...message })
  }
  return merged
}

function carriesTools(message: OutboundMessage): boolean {
  return Boolean(message.toolCalls?.length || message.toolResults?.length)
}

export function buildRequest(request: ProviderRequest): BuiltRequest {
  const { settings, apiKey } = request
  const messages = normalizeMessages(request.messages)
  const system = request.system.trim()

  const tools = request.tools ?? []

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
          messages: messages.map(anthropicMessage),
          ...(tools.length > 0
            ? {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters
                }))
              }
            : {}),
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
          ...messages.flatMap(openAiMessages)
        ],
        ...(tools.length > 0
          ? {
              tools: tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters
                }
              }))
            }
          : {}),
        stream: true
      })
    }
  }
}

/**
 * Anthropic carries tool use as typed blocks inside one message's content, and
 * a tool *result* as a user turn — which is why it is a content array rather
 * than the plain string an ordinary turn uses.
 */
function anthropicMessage(message: OutboundMessage): unknown {
  if (message.toolResults?.length) {
    return {
      role: 'user',
      content: message.toolResults.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.id,
        content: result.content
      }))
    }
  }

  if (message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: [
        ...(message.text ? [{ type: 'text', text: message.text }] : []),
        ...message.toolCalls.map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parseArgs(call.args)
        }))
      ]
    }
  }

  return { role: message.role, content: message.text }
}

/**
 * OpenAI puts calls on the assistant message and each result in its own message
 * with `role: 'tool'` — so one turn here can become several messages there,
 * which is why this returns an array where the Anthropic side returns one.
 */
function openAiMessages(message: OutboundMessage): unknown[] {
  if (message.toolResults?.length) {
    return message.toolResults.map((result) => ({
      role: 'tool',
      tool_call_id: result.id,
      content: result.content
    }))
  }

  if (message.toolCalls?.length) {
    return [
      {
        role: 'assistant',
        content: message.text || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.args || '{}' }
        }))
      }
    ]
  }

  return [{ role: message.role, content: message.text }]
}

/** Arguments reach us as JSON text; a malformed set becomes an empty object. */
function parseArgs(args: string): unknown {
  try {
    return args ? JSON.parse(args) : {}
  } catch {
    return {}
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
 * One piece of a streamed reply.
 *
 * Text and tool calls are separate cases rather than one string because a tool
 * call is not prose: concatenating it into the reply would print JSON into the
 * conversation and lose the structure the loop needs to act on. A call arrives
 * across several events — an opening block naming it, then its arguments in
 * fragments — so `argsDelta` accumulates against `index`.
 */
export type StreamPart =
  | { kind: 'text'; text: string }
  | { kind: 'toolStart'; index: number; id: string; name: string }
  | { kind: 'toolArgs'; index: number; argsDelta: string }

/**
 * What one event payload carries, if anything.
 *
 * Most events carry nothing — pings, role announcements, usage, stop reasons
 * and the `[DONE]` sentinel — so an empty array is the common case rather than
 * an error.
 */
export function partsFrom(provider: AiProviderId, payload: string): StreamPart[] {
  if (payload === '[DONE]') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    // A malformed event is not worth failing a whole reply over.
    return []
  }

  if (provider === 'anthropic') {
    const event = parsed as {
      type?: string
      index?: number
      content_block?: { type?: string; id?: string; name?: string }
      delta?: { type?: string; text?: string; partial_json?: string }
    }
    const index = event.index ?? 0

    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      return [
        {
          kind: 'toolStart',
          index,
          id: event.content_block.id ?? '',
          name: event.content_block.name ?? ''
        }
      ]
    }
    if (event.type !== 'content_block_delta') return []
    if (typeof event.delta?.partial_json === 'string') {
      return [{ kind: 'toolArgs', index, argsDelta: event.delta.partial_json }]
    }
    return typeof event.delta?.text === 'string' ? [{ kind: 'text', text: event.delta.text }] : []
  }

  const event = parsed as {
    choices?: {
      delta?: {
        content?: string | null
        tool_calls?: {
          index?: number
          id?: string
          function?: { name?: string; arguments?: string }
        }[]
      }
    }[]
  }
  const delta = event.choices?.[0]?.delta
  const parts: StreamPart[] = []

  if (typeof delta?.content === 'string' && delta.content.length > 0) {
    parts.push({ kind: 'text', text: delta.content })
  }

  for (const call of delta?.tool_calls ?? []) {
    const index = call.index ?? 0
    // A name arrives once, with the id; arguments arrive in fragments after it.
    // The two cases are distinguished by which fields the fragment carries, not
    // by its position, because a fragment can carry both.
    if (call.id || call.function?.name) {
      parts.push({ kind: 'toolStart', index, id: call.id ?? '', name: call.function?.name ?? '' })
    }
    if (call.function?.arguments) {
      parts.push({ kind: 'toolArgs', index, argsDelta: call.function.arguments })
    }
  }

  return parts
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
