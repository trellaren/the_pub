import type { ChatMessage } from '../../shared/model/ai.js'
import type { OutboundMessage } from './providers.js'

/**
 * The transcript, as the model should see it again.
 *
 * A stored assistant message that called tools becomes the pair every provider
 * expects — the call, then a turn carrying the results — so the model on turn
 * three remembers what it searched for on turn two instead of searching again.
 * Replaying only the text, as the first version did, left the agent amnesiac
 * about its own work.
 *
 * Results are replayed from `content` (what the model saw, clipped) and fall
 * back to `result` (the one-line summary) for messages written before
 * `content` was recorded.
 */
export function historyToOutbound(messages: readonly ChatMessage[]): OutboundMessage[] {
  const outbound: OutboundMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls.length > 0 && !isLocalError(message)) {
      outbound.push({
        role: 'assistant',
        text: message.text,
        toolCalls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, args: call.args }))
      })
      outbound.push({
        role: 'user',
        text: '',
        toolResults: message.toolCalls.map((call) => ({ id: call.id, content: call.content || call.result }))
      })
      continue
    }
    outbound.push({ role: message.role, text: message.text })
  }
  return outbound
}

/**
 * The renderer records a failed request as an assistant message of its own so
 * the failure shows in the thread. It never reached the provider, so it
 * carries no tool pairing worth replaying.
 */
function isLocalError(message: ChatMessage): boolean {
  return message.id.startsWith('error-')
}
