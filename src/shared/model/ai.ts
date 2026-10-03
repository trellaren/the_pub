import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'
import { DEFAULT_EMBEDDED_MODEL } from './llm.js'
import { assistantEditSchema } from '../pm/assistantEdits.js'

/**
 * The five backends the app talks to.
 *
 * Three are hosted and need a key; LM Studio runs on the author's own machine
 * and needs a URL instead; `embedded` is a model this app downloads and runs
 * itself, reached on a port only the main process knows. They are one list
 * because everything above this layer — chats, context, streaming, the panel —
 * is identical for all of them, which is what makes an embedded model an entry
 * here rather than a parallel feature.
 */
export const aiProviderIds = ['anthropic', 'openai', 'huggingface', 'lmstudio', 'embedded'] as const
export const aiProviderIdSchema = z.enum(aiProviderIds)
export type AiProviderId = z.infer<typeof aiProviderIdSchema>

export interface ProviderInfo {
  id: AiProviderId
  name: string
  /** False for a local server, which is reached by URL rather than by key. */
  needsKey: boolean
  defaultModel: string
  defaultBaseUrl: string
  /**
   * What to embed with, when the writer has not named a model.
   *
   * Empty means "whatever this backend already has loaded", which is right for
   * the two that serve one model at a time. Empty also on a backend with no
   * embeddings endpoint at all — see `embeddingsUrl` — where the absence is the
   * answer rather than a default worth guessing.
   */
  defaultEmbedModel: string
  /** Where to get a key, shown beside the field. */
  keyUrl?: string
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    needsKey: true,
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    // Anthropic has no embeddings endpoint; retrieval falls back rather than
    // inventing one.
    defaultEmbedModel: '',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    needsKey: true,
    defaultModel: 'gpt-4o',
    defaultBaseUrl: 'https://api.openai.com',
    defaultEmbedModel: 'text-embedding-3-small',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    needsKey: true,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    defaultBaseUrl: 'https://router.huggingface.co',
    defaultEmbedModel: 'sentence-transformers/all-MiniLM-L6-v2',
    keyUrl: 'https://huggingface.co/settings/tokens'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    needsKey: false,
    defaultModel: 'local-model',
    defaultBaseUrl: 'http://127.0.0.1:1234',
    defaultEmbedModel: ''
  },
  {
    id: 'embedded',
    name: 'Embedded',
    needsKey: false,
    defaultModel: DEFAULT_EMBEDDED_MODEL,
    // Filled in by main from the engine's actual port at request time. The
    // renderer never learns it, and a stale value here could only ever point
    // at the wrong process.
    defaultBaseUrl: '',
    defaultEmbedModel: ''
  }
]

export function providerInfo(id: AiProviderId): ProviderInfo {
  return PROVIDERS.find((provider) => provider.id === id)!
}

export const aiSettingsSchema = z.object({
  /**
   * Embedded by default: a fresh install has an assistant that works once a
   * model is downloaded, with nothing leaving the machine and no key to find.
   * The hosted providers are a choice, not a prerequisite.
   */
  provider: aiProviderIdSchema.default('embedded'),
  model: z.string().default(''),
  /** Overrides the provider default; how LM Studio is pointed at a port. */
  baseUrl: z.string().default(''),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(64).max(32_000).default(2048),
  /** Prepended to every conversation. The author's standing instructions. */
  systemPrompt: z.string().default(''),
  /**
   * What to embed the retrieval index with. Empty takes the provider's default.
   *
   * Its own field rather than reusing `model`, because on a hosted backend they
   * are different models entirely — asking OpenAI to embed with `gpt-4o` is a
   * 400, and a writer with no way to name the right one would have no way to
   * fix it.
   */
  embedModel: z.string().default('')
})
export type AiSettings = z.infer<typeof aiSettingsSchema>

/**
 * One tool the agent called, and what came back.
 *
 * Recorded on the message rather than in a private log: what the agent did is
 * part of what it said, and a run that is only auditable through a separate
 * file is a run nobody audits. `result` is the summary shown to a reader, not
 * the raw payload the model saw — a search that matched forty blocks should not
 * put forty blocks in the chat file.
 */
export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.string().default(''),
  result: z.string().default(''),
  /**
   * What the model saw, clipped to `MAX_TOOL_CONTENT_CHARS`, so the next turn
   * can replay it and the agent remembers its own searches. Empty on messages
   * written before it was recorded; `history.ts` falls back to `result`.
   */
  content: z.string().default(''),
  ok: z.boolean().default(true)
})
export const MAX_TOOL_CONTENT_CHARS = 4_000
export type ToolCall = z.infer<typeof toolCallSchema>

export const chatRoles = ['user', 'assistant'] as const
export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(chatRoles),
  text: z.string(),
  /** Which model produced it, so an old answer stays attributable. */
  model: z.string().default(''),
  /** What the agent did on the way to this answer. Empty for an ordinary reply. */
  toolCalls: z.array(toolCallSchema).default(() => []),
  created: z.string()
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

/**
 * Per-chat overrides of the project's settings.
 *
 * Spelled out as optionals rather than `aiSettingsSchema.partial()`, which
 * looks equivalent and is not: a partial of a schema whose every field carries
 * a default still *fills in* those defaults, so an untouched chat would come
 * back holding a complete settings object and silently override the project's
 * provider with the schema default. An override that is absent must stay
 * absent.
 */
export const aiSettingsOverrideSchema = z.object({
  provider: aiProviderIdSchema.optional(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(32_000).optional(),
  systemPrompt: z.string().optional(),
  embedModel: z.string().optional()
})
export type AiSettingsOverride = z.infer<typeof aiSettingsOverrideSchema>

export const chatSchema = z.object({
  id: z.string(),
  title: z.string(),
  messages: z.array(chatMessageSchema).default(() => []),
  /** Per-chat overrides, so one conversation can use a different model. */
  settings: aiSettingsOverrideSchema.prefault({}),
  created: z.string(),
  modified: z.string()
})
export type Chat = z.infer<typeof chatSchema>

export const chatFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.chats),
  chats: z.array(chatSchema).default(() => []),
  settings: aiSettingsSchema.prefault({})
})
export type ChatFile = z.infer<typeof chatFileSchema>

/**
 * What the author is asking about: the selection, the whole document, or
 * nothing.
 *
 * Context is attached per message rather than per chat because the useful unit
 * is "review *this* scene", and the scene changes as the conversation goes on.
 */
export const chatContextSchema = z.object({
  label: z.string(),
  text: z.string()
})
export type ChatContext = z.infer<typeof chatContextSchema>

/** A streamed reply, as it reaches the renderer. */
export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), requestId: z.string(), text: z.string() }),
  /**
   * A tool call, as it is made rather than when the run ends. An agent that
   * spends twenty seconds searching should say so while it searches.
   */
  z.object({ type: z.literal('tool'), requestId: z.string(), call: toolCallSchema }),
  /**
   * An edit to a document, described in block offsets and applied by whoever
   * holds the document: the renderer if it is open, main if it is not. In
   * `suggest` mode it lands as suggestion marks the writer judges in the
   * Review panel — the agent has no other reach into prose.
   */
  z.object({ type: z.literal('edit'), requestId: z.string(), edit: assistantEditSchema }),
  z.object({ type: z.literal('done'), requestId: z.string(), message: chatMessageSchema }),
  z.object({ type: z.literal('error'), requestId: z.string(), message: z.string() })
])
export type StreamEvent = z.infer<typeof streamEventSchema>

/** Merge project defaults with a chat's overrides. */
export function resolveSettings(base: AiSettings, overrides: AiSettingsOverride = {}): AiSettings {
  const merged = { ...base, ...clean(overrides) }
  const info = providerInfo(merged.provider)
  return {
    ...merged,
    model: merged.model || info.defaultModel,
    embedModel: merged.embedModel || info.defaultEmbedModel,
    baseUrl: (merged.baseUrl || info.defaultBaseUrl).replace(/\/+$/, '')
  }
}

/** Drop keys explicitly set to undefined or blank, which must not erase a default. */
function clean(overrides: AiSettingsOverride): AiSettingsOverride {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined && value !== '')
  ) as AiSettingsOverride
}
