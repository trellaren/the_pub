import type { AiSettings, StreamEvent, ToolCall } from '../../shared/model/ai.js'
import { MAX_TOOL_CONTENT_CHARS } from '../../shared/model/ai.js'
import type { AuthorProfile } from '../../shared/model/author.js'
import type { WritePolicy } from '../../shared/model/provenance.js'
import type { Capture } from '../../shared/model/research.js'
import { buildWebGate, type WebGate } from './webGate.js'
import type { AssistantEdit } from '../../shared/pm/assistantEdits.js'
import type { ProjectSession } from '../services/projectSession.js'
import { streamCompletion, assistantMessage, type AiRunner } from './aiRunner.js'
import { toolSpecs, runTool, type RetrievalResult, type ToolContext } from './tools.js'

type ToolContextSearch = NonNullable<ToolContext['search']>
type ToolContextFetch = NonNullable<ToolContext['fetchPage']>
import type { OutboundMessage } from './providers.js'

/**
 * How many requests one question may cost.
 *
 * A bound rather than a guess at what is enough: without it a model that keeps
 * calling the same tool spends the author's money — or their laptop's battery —
 * until something else stops it. Twelve is comfortably more than the two or
 * three a real question takes, and small enough to notice.
 */
export const MAX_STEPS = 12

export interface AgentRunOptions {
  requestId: string
  settings: AiSettings
  system: string
  messages: OutboundMessage[]
  apiKey: string | null
  session: ProjectSession
  /** Who the assistant is in this project — see `assistantProfile`. */
  assistant: AuthorProfile
  /** How its edits may land; `suggest` when unset. */
  writePolicy?: WritePolicy
  /** What it may reach on the web; nothing when unset. */
  web?: WebGate
  search?: ToolContextSearch
  fetchPage?: ToolContextFetch
  /**
   * Semantic retrieval, when this project has an index to search. Passed in
   * rather than reached for, because building the query vector needs the same
   * provider and key the reply is using, and tools know about neither.
   */
  findPassages?: (query: string, limit: number) => Promise<RetrievalResult>
  onEvent: (event: StreamEvent) => void
  /** A comment landed; the panel showing that document's threads should reload. */
  onReviewChanged?: (docId: string) => void
}

/**
 * A question answered with the project in hand.
 *
 * Kept beside `AiRunner` rather than inside it: a plain send is one request,
 * and this is a loop over requests with tool results appended between them.
 * Merging the two would put a loop in the path of every ordinary message, and
 * the ordinary message is the common case.
 *
 * The loop is deliberately dull. It streams a reply, runs whatever tools were
 * asked for, appends the results, and goes round again until the model answers
 * without calling anything — or until the step budget runs out.
 */
export async function runAgent(runner: AiRunner, options: AgentRunOptions): Promise<void> {
  const { requestId, settings, session, onEvent } = options
  const controller = runner.track(requestId)
  const web = options.web ?? buildWebGate('none')
  const tools = toolSpecs({ retrieval: Boolean(options.findPassages), web: web.level })
  const captures = new Map<string, Capture>()

  const conversation: OutboundMessage[] = [...options.messages]
  const performed: ToolCall[] = []
  const ensembleAttempts = new Map<string, number>()
  let answer = ''

  try {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const outcome = await streamCompletion(
        {
          settings,
          system: options.system,
          messages: conversation,
          apiKey: options.apiKey,
          tools
        },
        controller.signal,
        (delta) => onEvent({ type: 'delta', requestId, text: delta })
      )

      if (outcome.error) {
        onEvent({ type: 'error', requestId, message: outcome.error })
        return
      }

      answer = outcome.text

      // No tool calls means this was the answer. The overwhelming majority of
      // runs end here, on the first pass.
      if (outcome.aborted || outcome.toolCalls.length === 0) {
        onEvent({
          type: 'done',
          requestId,
          message: assistantMessage(answer, settings.model, performed)
        })
        return
      }

      conversation.push({ role: 'assistant', text: outcome.text, toolCalls: outcome.toolCalls })

      const results: { id: string; content: string }[] = []
      for (const call of outcome.toolCalls) {
        if (controller.signal.aborted) break

        const edits: AssistantEdit[] = []
        const result = await runTool(call.name, call.args, {
          session,
          assistant: options.assistant,
          runId: requestId,
          model: settings.model,
          writePolicy: options.writePolicy ?? 'suggest',
          web,
          search: options.search,
          fetchPage: options.fetchPage,
          captures,
          findPassages: options.findPassages,
          ensembleAttempts,
          onEdit: (edit) => edits.push(edit),
          onReviewChanged: (docId) => options.onReviewChanged?.(docId),
          complete: async (system, user, maxTokens) => {
            const nested = await streamCompletion(
              {
                settings: { ...settings, maxTokens },
                system,
                messages: [{ role: 'user', text: user }],
                apiKey: options.apiKey
              },
              controller.signal,
              () => {}
            )
            if (nested.error) throw new Error(nested.error)
            return nested.text
          }
        })

        const record: ToolCall = {
          id: call.id,
          name: call.name,
          args: call.args,
          result: result.summary,
          content: result.content.slice(0, MAX_TOOL_CONTENT_CHARS),
          ok: result.ok
        }
        performed.push(record)
        // Emitted as it happens rather than at the end: an agent that spends
        // twenty seconds searching should say so while it searches.
        onEvent({ type: 'tool', requestId, call: record })
        for (const edit of edits) onEvent({ type: 'edit', requestId, edit })

        results.push({ id: call.id, content: result.content })
      }

      if (controller.signal.aborted) {
        onEvent({
          type: 'done',
          requestId,
          message: assistantMessage(answer, settings.model, performed)
        })
        return
      }

      conversation.push({ role: 'user', text: '', toolResults: results })
    }

    // Out of steps. Said plainly rather than silently returning whatever the
    // last pass happened to hold: a truncated answer that looks complete is
    // worse than one that admits it stopped.
    onEvent({
      type: 'done',
      requestId,
      message: assistantMessage(
        answer
          ? `${answer}\n\n_(Stopped after ${MAX_STEPS} steps.)_`
          : `_Stopped after ${MAX_STEPS} steps without reaching an answer._`,
        settings.model,
        performed
      )
    })
  } finally {
    runner.release(requestId)
  }
}
