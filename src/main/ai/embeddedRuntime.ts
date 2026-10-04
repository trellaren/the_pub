import type { AppStateService } from '../services/appState.js'
import type { ProjectSession } from '../services/projectSession.js'
import type { ModelStore } from '../llm/modelStore.js'
import type { LlmEngine } from '../llm/engine.js'
import { resolveSettings, providerInfo } from '../../shared/model/ai.js'
import { resolveVariant, isSideloadedModel, DEFAULT_SIDELOAD_CONTEXT } from '../../shared/model/llm.js'
import type { KeyId } from '../../shared/model/webAccess.js'
import { Embedder, embedderConfig, embedderRefusal } from './embedder.js'
import type { EmbedderResolution } from './embeddingIndexer.js'

export interface EmbeddedRuntimeDeps {
  engine: LlmEngine
  models: ModelStore
}

export interface EmbedderDeps extends EmbeddedRuntimeDeps {
  appState: AppStateService
  sessions: { get(ownerId: number): ProjectSession | undefined }
  keyFor(id: KeyId, url: string, defaultUrl: string, name: string, askerWindowId?: number): Promise<string | null>
  hasKey(id: KeyId): boolean
}

/**
 * Get the embedded model running, and say where to send.
 *
 * Absent weights fail here rather than starting a download: pressing send is
 * never what begins a 16 GB transfer, and the panel turns this message into
 * the affordance that does.
 */
export async function startEmbedded({ engine, models }: EmbeddedRuntimeDeps, model: string): Promise<string> {
  if (!engine.available()) {
    throw new Error('This build has no embedded model runtime for your platform.')
  }

  if (isSideloadedModel(model)) {
    const file = models.resolveSideloaded(model)
    if (!file) throw new Error(`No model file at ${model}.`)
    const url = await engine.ensure({
      modelPath: file,
      modelId: model,
      contextLength: DEFAULT_SIDELOAD_CONTEXT
    })
    if (!url) throw new Error(engine.status().message || 'The embedded model could not start.')
    return url
  }

  const variant = resolveVariant(model)
  if (!variant) throw new Error(`"${model}" is not a model this build knows about.`)

  const file = models.resolve(variant.id)
  if (!file) {
    throw new Error(`${variant.label} is not downloaded yet. Download it in the AI settings.`)
  }

  const url = await engine.ensure({
    modelPath: file,
    modelId: variant.id,
    contextLength: variant.contextLength
  })
  if (!url) throw new Error(engine.status().message || 'The embedded model could not start.')
  return url
}

/**
 * Find something to embed with, or say why there is nothing.
 *
 * `allowStart` is the whole of the policy. A person who pressed Build has
 * asked for this and may be charged a model load or a hosted API call for it;
 * the background top-up that runs when a project opens has asked for nothing,
 * and gets an embedder only if one is already there and free. That is what
 * keeps a manuscript from being quietly posted to a paid endpoint, and a
 * laptop from warming up for reasons its owner cannot account for.
 */
export async function resolveEmbedder(
  deps: EmbedderDeps,
  ownerId: number,
  allowStart: boolean
): Promise<EmbedderResolution> {
  const { appState, sessions, engine, keyFor } = deps
  if (!appState.get().aiEnabled) {
    return { embedder: null, unavailable: 'AI features are turned off.' }
  }
  const session = sessions.get(ownerId)
  if (!session) return { embedder: null, unavailable: 'No project is open.' }

  const settings = resolveSettings(session.chats.settings())
  const info = providerInfo(settings.provider)
  // Only a build the author asked for may ask them to confirm a custom host;
  // the background passes that run on open must not raise a dialog.
  const apiKey = await keyFor(
    settings.provider,
    settings.baseUrl,
    info.defaultBaseUrl,
    info.name,
    allowStart ? ownerId : undefined
  )
  if (info.needsKey && !apiKey) {
    if (!deps.hasKey(settings.provider)) {
      return { embedder: null, unavailable: `No API key is set for ${info.name}.` }
    }
    return {
      embedder: null,
      unavailable: allowStart
        ? `Your ${info.name} key was not sent to ${settings.baseUrl}.`
        : `Build the index to confirm sending your ${info.name} key to ${settings.baseUrl}.`
    }
  }

  let baseUrl = settings.baseUrl
  if (settings.provider === 'embedded') {
    const running = engine.runningUrl()
    if (!running && !allowStart) {
      return {
        embedder: null,
        unavailable: 'The embedded model is not running. Build the index to start it.'
      }
    }
    if (running) baseUrl = running
    else {
      try {
        baseUrl = await startEmbedded(deps, settings.model)
      } catch (error) {
        return { embedder: null, unavailable: error instanceof Error ? error.message : String(error) }
      }
    }
  } else if (info.needsKey && !allowStart) {
    return {
      embedder: null,
      unavailable: `Indexing with ${info.name} sends your manuscript to them, so it only happens when you ask for it.`
    }
  }

  const config = {
    ...embedderConfig({ ...settings, baseUrl }, apiKey),
    ...(settings.provider === 'embedded'
      ? { identity: `embedded ${engine.status().model} ${settings.embedModel}` }
      : {})
  }
  const refusal = embedderRefusal(config, info.name)
  if (refusal) return { embedder: null, unavailable: refusal }
  return { embedder: new Embedder(config), unavailable: '' }
}
