import { ulid } from 'ulid'
import type { AiSettings, ChatMessage, StreamEvent } from '../../shared/model/ai.js'
import { providerInfo } from '../../shared/model/ai.js'
import {
  buildRequest,
  SseParser,
  deltaFrom,
  errorMessage,
  modelsUrl,
  parseModelList,
  type OutboundMessage
} from './providers.js'

export interface RunOptions {
  requestId: string
  settings: AiSettings
  system: string
  messages: OutboundMessage[]
  apiKey: string | null
  onEvent: (event: StreamEvent) => void
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

  async run(options: RunOptions): Promise<void> {
    const { requestId, settings, onEvent } = options
    const controller = new AbortController()
    this.inFlight.set(requestId, controller)

    let text = ''
    try {
      const { url, init } = buildRequest({
        settings,
        system: options.system,
        messages: options.messages,
        apiKey: options.apiKey
      })

      const response = await fetch(url, { ...init, signal: controller.signal })
      if (!response.ok) {
        onEvent({
          type: 'error',
          requestId,
          message: errorMessage(response.status, await response.text().catch(() => ''))
        })
        return
      }
      if (!response.body) {
        onEvent({ type: 'error', requestId, message: 'The provider returned an empty response.' })
        return
      }

      const decoder = new TextDecoder()
      const parser = new SseParser()
      const reader = response.body.getReader()

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          const delta = deltaFrom(settings.provider, payload)
          if (delta === null) continue
          text += delta
          // Deltas go straight out rather than being buffered: watching a reply
          // arrive is most of why streaming is worth the complexity.
          onEvent({ type: 'delta', requestId, text: delta })
        }
      }
      for (const payload of parser.flush()) {
        const delta = deltaFrom(settings.provider, payload)
        if (delta !== null) {
          text += delta
          onEvent({ type: 'delta', requestId, text: delta })
        }
      }

      const message: ChatMessage = {
        id: ulid(),
        role: 'assistant',
        text,
        model: settings.model,
        created: new Date().toISOString()
      }
      onEvent({ type: 'done', requestId, message })
    } catch (error) {
      if (controller.signal.aborted) {
        // A cancelled reply still keeps whatever had already arrived: the
        // author stopped it because they had read enough, not to undo it.
        onEvent({
          type: 'done',
          requestId,
          message: {
            id: ulid(),
            role: 'assistant',
            text,
            model: settings.model,
            created: new Date().toISOString()
          }
        })
        return
      }
      onEvent({ type: 'error', requestId, message: describe(error, settings) })
    } finally {
      this.inFlight.delete(requestId)
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
