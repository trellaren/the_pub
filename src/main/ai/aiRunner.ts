import { ulid } from 'ulid'
import type { AiSettings, ChatMessage, StreamEvent } from '../../shared/model/ai.js'
import { providerInfo } from '../../shared/model/ai.js'
import {
  buildRequest,
  SseParser,
  partsFrom,
  errorMessage,
  modelsUrl,
  parseModelList,
  type OutboundMessage,
  type OutboundToolCall,
  type ProviderRequest
} from './providers.js'

export interface RunOptions {
  requestId: string
  settings: AiSettings
  system: string
  messages: OutboundMessage[]
  apiKey: string | null
  onEvent: (event: StreamEvent) => void
}

/** What one completed request produced. */
export interface StreamOutcome {
  text: string
  toolCalls: OutboundToolCall[]
  /** Set when the request failed outright; the text may still hold a partial reply. */
  error: string | null
  aborted: boolean
}

/**
 * Run one request against a provider and stream its text back.
 *
 * Split out of `AiRunner` because the agent loop needs exactly this and nothing
 * else: it calls tools between requests, so it needs the individual request,
 * not the store-and-finish behaviour wrapped around it. One implementation
 * serves both, which is what keeps a plain send and an agent step from drifting
 * in how they parse a stream.
 */
export async function streamCompletion(
  request: ProviderRequest,
  signal: AbortSignal,
  onText: (delta: string) => void
): Promise<StreamOutcome> {
  let text = ''
  // Keyed by the index the provider assigns, because arguments arrive in
  // fragments and the events interleave when a model calls two tools at once.
  const pending = new Map<number, { id: string; name: string; args: string }>()

  const collect = (payload: string): void => {
    for (const part of partsFrom(request.settings.provider, payload)) {
      if (part.kind === 'text') {
        text += part.text
        // Deltas go straight out rather than being buffered: watching a reply
        // arrive is most of why streaming is worth the complexity.
        onText(part.text)
        continue
      }
      if (part.kind === 'toolStart') {
        const existing = pending.get(part.index)
        pending.set(part.index, {
          id: part.id || existing?.id || ulid(),
          name: part.name || existing?.name || '',
          args: existing?.args ?? ''
        })
        continue
      }
      const existing = pending.get(part.index) ?? { id: ulid(), name: '', args: '' }
      pending.set(part.index, { ...existing, args: existing.args + part.argsDelta })
    }
  }

  const finish = (error: string | null, aborted = false): StreamOutcome => ({
    text,
    toolCalls: [...pending.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ id: call.id, name: call.name, args: call.args }))
      .filter((call) => call.name.length > 0),
    error,
    aborted
  })

  try {
    const { url, init } = buildRequest(request)
    const response = await fetch(url, { ...init, signal })

    if (!response.ok) {
      return finish(errorMessage(response.status, await response.text().catch(() => '')))
    }
    if (!response.body) return finish('The provider returned an empty response.')

    const decoder = new TextDecoder()
    const parser = new SseParser()
    const reader = response.body.getReader()

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const payload of parser.push(decoder.decode(value, { stream: true }))) collect(payload)
    }
    for (const payload of parser.flush()) collect(payload)

    return finish(null)
  } catch (error) {
    if (signal.aborted) return finish(null, true)
    return finish(describe(error, request.settings))
  }
}

/**
 * Run one request and stream it back.
 *
 * Everything network-facing lives in main: the renderer never sees an API key,
 * and its content-security-policy would refuse the call anyway. Requests are
 * tracked by id so a reply can be cancelled — a long generation the author has
 * stopped reading should stop costing them money.
 */
export class AiRunner {
  private inFlight = new Map<string, AbortController>()

  cancel(requestId: string): void {
    this.inFlight.get(requestId)?.abort()
    this.inFlight.delete(requestId)
  }

  cancelAll(): void {
    for (const controller of this.inFlight.values()) controller.abort()
    this.inFlight.clear()
  }

  /** A controller the agent loop can register under its own request id. */
  track(requestId: string): AbortController {
    const controller = new AbortController()
    this.inFlight.set(requestId, controller)
    return controller
  }

  release(requestId: string): void {
    this.inFlight.delete(requestId)
  }

  async run(options: RunOptions): Promise<void> {
    const { requestId, settings, onEvent } = options
    const controller = this.track(requestId)

    try {
      const outcome = await streamCompletion(
        {
          settings,
          system: options.system,
          messages: options.messages,
          apiKey: options.apiKey
        },
        controller.signal,
        (delta) => onEvent({ type: 'delta', requestId, text: delta })
      )

      if (outcome.error) {
        onEvent({ type: 'error', requestId, message: outcome.error })
        return
      }

      // A cancelled reply still keeps whatever had already arrived: the author
      // stopped it because they had read enough, not to undo it.
      onEvent({
        type: 'done',
        requestId,
        message: assistantMessage(outcome.text, settings.model)
      })
    } finally {
      this.release(requestId)
    }
  }

  async listModels(settings: AiSettings, apiKey: string | null): Promise<string[]> {
    const url = modelsUrl(settings)
    if (!url) return []
    const response = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}
    })
    if (!response.ok) return []
    return parseModelList(await response.json().catch(() => null))
  }
}

export function assistantMessage(
  text: string,
  model: string,
  toolCalls: ChatMessage['toolCalls'] = []
): ChatMessage {
  return {
    id: ulid(),
    role: 'assistant',
    text,
    model,
    toolCalls,
    created: new Date().toISOString()
  }
}

/** Turn a thrown network error into something an author can act on. */
function describe(error: unknown, settings: AiSettings): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    const info = providerInfo(settings.provider)
    return info.needsKey
      ? `Could not reach ${info.name} at ${settings.baseUrl}. Check the connection and the base URL.`
      : `Could not reach ${info.name} at ${settings.baseUrl}. Is the local server running?`
  }
  return message
}
