import os from 'node:os'
import { dialog } from 'electron'
import { ulid } from 'ulid'
import type { ProjectSession } from '../../services/projectSession.js'
import { streamCompletion } from '../../ai/aiRunner.js'
import { isFresh, pickAngle, promptRequest, today, EMPTY_DAILY_PROMPT } from '../../../shared/model/writingPrompt.js'
import {
  aiSettingsSchema,
  resolveSettings,
  providerInfo,
  type ChatMessage,
  type StreamEvent
} from '../../../shared/model/ai.js'
import type { LlmProgress } from '../../../shared/model/llm.js'
import { runAgent } from '../../ai/agentRunner.js'
import { historyToOutbound } from '../../ai/history.js'
import { describeProject, projectFacts } from '../../ai/projectContext.js'
import { buildWebGate, extractUrls } from '../../ai/webGate.js'
import { webSearch } from '../../research/webSearch.js'
import { searchKeyId, searchProviderInfo, type WebSearchHit } from '../../../shared/model/webAccess.js'
import { applyAssistantEdit } from '../../../shared/pm/assistantEdits.js'
import { unionProvenance } from '../../../shared/model/provenance.js'
import { RECORD_WRITING_TOOLS, SOURCE_WRITING_TOOLS, type RetrievalResult } from '../../ai/tools.js'
import { capturePage } from '../../research/capture.js'
import {
  ASSISTANT_PREAMBLE,
  PROMPT_TIMEOUT_MS,
  WEB_TIMEOUT_MS,
  emptyFacts,
  fetchWithLimits
} from '../../ai/assistantSupport.js'
import type { HandlerContext } from '../context.js'

export function register(ctx: HandlerContext): void {
  const {
    handle,
    windows,
    sessions,
    appState,
    models,
    engine,
    keys,
    keyFor,
    requireSession,
    ownerWindow,
    resolveEmbedder,
    startEmbedded,
    commitDocumentWrite,
    rescan,
    reviewChanged
  } = ctx

  /** A web search through the writer's chosen provider, with its key. */
  async function searchTheWeb(query: string, limit: number): Promise<{ ok: true; hits: WebSearchHit[] } | { ok: false; reason: string }> {
    const state = appState.get()
    const provider = state.aiSearchProvider
    const info = searchProviderInfo(provider)
    const result = await webSearch(provider, query, limit, {
      apiKey: await keyFor(searchKeyId(provider), state.aiSearchBaseUrl || info.defaultBaseUrl, info.defaultBaseUrl, info.name),
      baseUrl: state.aiSearchBaseUrl,
      fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(WEB_TIMEOUT_MS) })
    })
    return result.ok ? result : { ok: false, reason: result.reason }
  }

  /** Search this project by meaning, for the agent's `find_passages` tool. */
  async function findPassages(
    ownerId: number,
    session: ProjectSession,
    query: string,
    limit: number
  ): Promise<RetrievalResult> {
    const coverage = session.search.embeddingCoverage()
    // Allowed to start, because a person asked a question and is waiting: this
    // runs inside a reply they are watching stream, not in the background.
    const { embedder } = await resolveEmbedder(ownerId, true)
    if (!embedder) return { hits: [], ...coverage }
    const [vector] = await embedder.embed([query])
    if (!vector) return { hits: [], ...coverage }
    return { hits: session.search.nearestBlocks(vector, limit), ...coverage }
  }

  handle('ai:list', (_payload, event) => requireSession(event).chats.snapshot())
  handle('ai:createChat', ({ title }, event) => requireSession(event).chats.create(title))
  handle('ai:saveChat', ({ chat }, event) => requireSession(event).chats.save(chat))
  handle('ai:deleteChat', async ({ id }, event) => {
    await requireSession(event).chats.remove(id)
    return { ok: true as const }
  })
  handle('ai:saveSettings', ({ settings }, event) =>
    requireSession(event).chats.saveSettings(settings)
  )

  handle('ai:retrievalStatus', (_payload, event) => requireSession(event).retrieval.status())
  handle('ai:buildRetrieval', (_payload, event) => requireSession(event).retrieval.build(true))
  /**
   * Today's writing prompt for the welcome screen.
   *
   * Cached per day in app state, so opening the app four times in a morning
   * costs one request rather than four — and so the prompt a writer read at
   * breakfast is still there at lunch, which is most of what makes it feel like
   * a thing rather than a slot machine.
   *
   * Every unavailable case returns an empty prompt rather than throwing: the
   * welcome screen is not a place to show an error about a feature nobody asked
   * for, and the card simply does not appear.
   */
  handle('ai:dailyPrompt', async ({ refresh }, event) => {
    const stored = appState.get().dailyPrompt
    if (!refresh && isFresh(stored)) return stored
    if (!appState.get().aiEnabled) return EMPTY_DAILY_PROMPT

    const ownerId = windows.ownerWindowId(event.sender)
    const session = ownerId === null ? undefined : sessions.get(ownerId)
    const settings = resolveSettings(session?.chats.settings() ?? aiSettingsSchema.parse({}))
    const info = providerInfo(settings.provider)
    const apiKey = await keyFor(settings.provider, settings.baseUrl, info.defaultBaseUrl, info.name)
    if (info.needsKey && !apiKey) return EMPTY_DAILY_PROMPT

    let baseUrl = settings.baseUrl
    if (settings.provider === 'embedded') {
      // Never downloads and never waits on a cold start here: an app that
      // fetched gigabytes because someone opened the welcome screen would be an
      // app people learn to avoid opening.
      const running = engine.runningUrl()
      if (!running) return EMPTY_DAILY_PROMPT
      baseUrl = running
    }

    const angle = pickAngle(stored.angle)
    // Rooted in the open project when there is one; the generic prompt
    // otherwise, since the welcome screen also shows before a project opens.
    const brief = session ? describeProject(await projectFacts(session).catch(() => emptyFacts(session))) : ''
    const outcome = await streamCompletion(
      {
        settings: { ...settings, baseUrl, maxTokens: 200 },
        system: 'You write short, concrete writing prompts.',
        messages: [{ role: 'user', text: promptRequest(angle, brief) }],
        apiKey
      },
      AbortSignal.timeout(PROMPT_TIMEOUT_MS),
      () => {}
    ).catch(() => null)

    const text = outcome?.text.trim() ?? ''
    if (!text || outcome?.error) return EMPTY_DAILY_PROMPT
    return appState.setDailyPrompt({ date: today(), text, angle })
  })

  handle('ai:cancelRetrieval', (_payload, event) => {
    requireSession(event).retrieval.cancel()
    return { ok: true as const }
  })

  handle('llm:status', async () => ({
    variants: await models.status(),
    engine: engine.status(),
    totalMemoryBytes: os.totalmem(),
    runtimeAvailable: engine.available()
  }))

  handle('llm:download', async ({ variantId }, event) => {
    const ownerId = windows.ownerWindowId(event.sender)
    const emit = (progress: LlmProgress): void => {
      // Broadcast rather than sent to one window: a download belongs to the
      // app, and a second window with the manager open should see it move.
      if (ownerId !== null) windows.sendToSession(ownerId, 'llm:progress', progress)
    }

    const result = await models.download(variantId, (receivedBytes, totalBytes) =>
      emit({ variantId, receivedBytes, totalBytes, done: false, error: '' })
    )
    emit({
      variantId,
      receivedBytes: result.bytes,
      totalBytes: result.bytes,
      done: true,
      error: result.error ?? ''
    })
    return { ok: result.ok, error: result.error ?? '' }
  })

  handle('llm:cancelDownload', ({ variantId }) => {
    models.cancel(variantId)
    return { ok: true as const }
  })

  handle('llm:chooseFile', async (_payload, event) => {
    const result = await dialog.showOpenDialog(ownerWindow(event), {
      title: 'Choose a model file',
      message: 'Choose a .gguf model file already on this computer',
      buttonLabel: 'Use this model',
      properties: ['openFile'],
      filters: [{ name: 'Model weights', extensions: ['gguf'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return { path: result.filePaths[0]! }
  })

  handle('llm:remove', async ({ variantId }) => {
    // Stop it before deleting the file underneath it.
    if (engine.status().model === variantId) await engine.stop()
    await models.remove(variantId)
    return { ok: true as const }
  })

  handle('ai:keyStatus', () => ({
    configured: keys.configured(),
    secureStorage: keys.available()
  }))
  handle('ai:setKey', ({ provider, key }) => keys.set(provider, key))
  handle('ai:listModels', async ({ settings }, event) => {
    const resolved = resolveSettings(settings)
    const info = providerInfo(resolved.provider)
    const apiKey = await keyFor(resolved.provider, resolved.baseUrl, info.defaultBaseUrl, info.name, event)
    return requireSession(event).ai.listModels(resolved, apiKey)
  })

  /**
   * Send a message and stream the reply.
   *
   * The user's message is stored before the request goes out, so a failed or
   * cancelled reply still leaves what they wrote in the conversation.
   */
  handle('ai:send', async ({ chatId, text, context: attached, activeDocId }, event) => {
    const session = requireSession(event)
    const chat = session.chats.get(chatId)
    if (!chat) throw new Error('That chat no longer exists')

    // Defence in depth. The renderer registers no AI surface when this is off,
    // so reaching here means something bypassed the UI — a stale popout, or a
    // caller that should not exist.
    if (!appState.get().aiEnabled) throw new Error('AI features are turned off.')

    let settings = resolveSettings(session.chats.settings(), chat.settings)
    const info = providerInfo(settings.provider)
    const apiKey = await keyFor(settings.provider, settings.baseUrl, info.defaultBaseUrl, info.name, event)
    if (info.needsKey && !apiKey) {
      throw new Error(`No API key is set for ${info.name}. Add one in the AI panel's settings.`)
    }

    if (settings.provider === 'embedded') {
      settings = { ...settings, baseUrl: await startEmbedded(settings.model) }
    }

    const body = attached.trim() ? `${text}\n\n---\n${attached.trim()}` : text
    const message: ChatMessage = {
      id: ulid(),
      role: 'user',
      text: body,
      model: '',
      toolCalls: [],
      created: new Date().toISOString()
    }
    const updated = await session.chats.append(chatId, message)
    if (!updated) throw new Error('That chat no longer exists')

    const requestId = ulid()
    const ownerId = windows.ownerWindowId(event.sender)
    const onEvent = (streamEvent: StreamEvent): void => {
      if (ownerId !== null) windows.sendToSession(ownerId, 'ai:stream', streamEvent)
      // A drafted cast the writer cannot see until they reopen the project is
      // one they will assume failed, so the panel owning what was written is
      // told the moment the tool call lands rather than at the end of the run.
      if (streamEvent.type === 'tool' && ownerId !== null) {
        if (RECORD_WRITING_TOOLS.includes(streamEvent.call.name)) {
          windows.sendToSession(ownerId, 'entities:changed', {})
          rescan(event)
        }
        if (SOURCE_WRITING_TOOLS.includes(streamEvent.call.name)) {
          windows.sendToSession(ownerId, 'sources:changed', {})
        }
      }
      // A generation in progress is not an idle app, however long it runs.
      if (settings.provider === 'embedded') engine.keepAlive()
      // Persist only the finished reply: writing every delta would rewrite the
      // whole chat file on each token.
      if (streamEvent.type === 'done') {
        void session.chats.append(chatId, streamEvent.message).catch(() => {})
        // The moment a model is warm is the cheapest moment to embed, so a
        // finished reply is what tops the index up. Still `false`: this is the
        // app noticing an opportunity, not the writer asking.
        void session.retrieval.build(false).catch(() => {})
      }
    }

    // Semantic search is offered only when there is something to search. A
    // project with an empty index gets the keyword tools and no mention of the
    // other, rather than a tool the model spends a step calling to be told it
    // is useless.
    const indexed = session.search.embeddingCoverage().embedded > 0
    void runAgent(session.ai, {
      requestId,
      settings,
      system: [
        ASSISTANT_PREAMBLE,
        describeProject(await projectFacts(session, activeDocId || undefined).catch(() => emptyFacts(session))),
        settings.systemPrompt.trim()
      ]
        .filter(Boolean)
        .join('\n\n'),
      messages: historyToOutbound(updated.messages),
      apiKey,
      onEvent,
      session,
      assistant: appState.assistant(),
      writePolicy: appState.get().aiWritePolicy,
      web: buildWebGate(appState.get().aiWebAccess, [
        // Pages the writer has already put in front of the assistant: in this
        // conversation, or in the project's own bibliography.
        ...updated.messages.filter((item) => item.role === 'user').flatMap((item) => extractUrls(item.text)),
        ...session.sources.snapshot().sources.map((source) => source.URL).filter((url): url is string => Boolean(url))
      ]),
      search: (query: string, limit: number) => searchTheWeb(query, limit),
      fetchPage: (url: string) => capturePage(url, fetchWithLimits),
      onReviewChanged: (docId) => reviewChanged(event, docId),
      ...(indexed && ownerId !== null
        ? { findPassages: (query: string, limit: number) => findPassages(ownerId, session, query, limit) }
        : {})
    }).catch(() => {})

    return { requestId, message }
  })

  handle('ai:cancel', ({ requestId }, event) => {
    requireSession(event).ai.cancel(requestId)
    return { ok: true as const }
  })

  handle('ai:applyEdit', async ({ edit }, event) => {
    const session = requireSession(event)
    // Once more on a conflict, because the likeliest other writer is this
    // window's own autosave landing a moment earlier; a second conflict is a
    // real one and is reported.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let loaded
      try {
        loaded = await session.documents.read(edit.docPath)
      } catch {
        return { ok: false as const, reason: 'missing' as const }
      }
      const applied = applyAssistantEdit(loaded.doc.content, edit)
      if (applied.failed.length === edit.ops.length) return { ok: false as const, reason: 'no-match' as const }
      const written = await commitDocumentWrite(
        event,
        edit.docPath,
        {
          ...loaded.doc,
          content: applied.doc,
          ...(applied.entries.length ? { provenance: unionProvenance(loaded.doc.provenance, applied.entries) } : {})
        },
        loaded.mtime
      )
      if (written.ok) return { ok: true as const, failed: applied.failed }
      if (written.reason !== 'conflict') return { ok: false as const, reason: written.reason }
    }
    return { ok: false as const, reason: 'conflict' as const }
  })
}
