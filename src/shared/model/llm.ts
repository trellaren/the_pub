import { z } from 'zod'

/**
 * Models the app can run itself, and the quantisations each ships in.
 *
 * A curated table rather than a search over a model hub: the promise this
 * feature makes is "this one works on your machine", and that promise cannot be
 * made about an arbitrary file. Sideloading a local `.gguf` stays possible
 * (`aiSettings.model` may hold a path — see `isSideloadedModel`), but it is an
 * escape hatch, not the product.
 *
 * The engine is model-agnostic — GGUF in, tokens out — so a new model is an
 * entry here and nothing else.
 */
export const modelVariantSchema = z.object({
  id: z.string(),
  /** What the picker shows, including the memory it wants. */
  label: z.string(),
  url: z.string(),
  bytes: z.number().int(),
  /**
   * Expected digest of the completed file.
   *
   * Empty means this build cannot verify the download. That is a real state,
   * not an oversight: a catalogue entry whose upstream digest has not been
   * pinned yet must not silently pass verification, so `verifyState` reports it
   * as `unverified` and the UI says so rather than claiming a check it did not
   * make.
   */
  sha256: z.string(),
  /** Refuse below this much total system memory. */
  minMemoryBytes: z.number().int(),
  /** Context window to start `llama-server` with. */
  contextLength: z.number().int()
})
export type ModelVariant = z.infer<typeof modelVariantSchema>

export const embeddedModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  /** One line, shown under the name in the manager. */
  summary: z.string(),
  license: z.object({ name: z.string(), url: z.string() }),
  variants: z.array(modelVariantSchema)
})
export type EmbeddedModel = z.infer<typeof embeddedModelSchema>

const GB = 1024 ** 3

/**
 * The catalogue.
 *
 * Three models spanning the hardware range rather than the leaderboard: a
 * writer on 8 GB should get a private, offline assistant rather than a refusal,
 * which is the whole reason the gate is per variant rather than per feature.
 *
 * `bytes` and `sha256` are pinned at release from the published artefacts. The
 * placeholders below are inert rather than dangerous — an empty digest reports
 * as `unverified` (see `modelVariantSchema.sha256`) instead of passing a check
 * that never ran.
 */
export const EMBEDDED_MODELS: EmbeddedModel[] = [
  {
    id: 'bonsai-27b',
    name: 'Bonsai 27B',
    vendor: 'prism-ml',
    summary: 'The strongest of the three. Wants a well-equipped desktop or laptop.',
    license: { name: 'Prism-ML Open Weights', url: 'https://prism-ml.example/bonsai/license' },
    variants: [
      {
        id: 'bonsai-27b-q4_k_m',
        label: 'Standard — 16 GB',
        url: 'https://huggingface.co/prism-ml/bonsai-27b-GGUF/resolve/main/bonsai-27b-Q4_K_M.gguf',
        bytes: 16 * GB,
        sha256: '',
        minMemoryBytes: 24 * GB,
        contextLength: 8192
      },
      {
        id: 'bonsai-27b-q8_0',
        label: 'High quality — 28 GB',
        url: 'https://huggingface.co/prism-ml/bonsai-27b-GGUF/resolve/main/bonsai-27b-Q8_0.gguf',
        bytes: 28 * GB,
        sha256: '',
        minMemoryBytes: 40 * GB,
        contextLength: 8192
      }
    ]
  },
  {
    id: 'bonsai-9b',
    name: 'Bonsai 9B',
    vendor: 'prism-ml',
    summary: 'Most of the quality at a third of the memory. The sensible default on a laptop.',
    license: { name: 'Prism-ML Open Weights', url: 'https://prism-ml.example/bonsai/license' },
    variants: [
      {
        id: 'bonsai-9b-q4_k_m',
        label: 'Standard — 6 GB',
        url: 'https://huggingface.co/prism-ml/bonsai-9b-GGUF/resolve/main/bonsai-9b-Q4_K_M.gguf',
        bytes: 6 * GB,
        sha256: '',
        minMemoryBytes: 12 * GB,
        contextLength: 8192
      }
    ]
  },
  {
    id: 'bonsai-4b',
    name: 'Bonsai 4B',
    vendor: 'prism-ml',
    summary: 'Runs on a modest machine. Good for questions and rewrites, weaker on long reasoning.',
    license: { name: 'Prism-ML Open Weights', url: 'https://prism-ml.example/bonsai/license' },
    variants: [
      {
        id: 'bonsai-4b-q4_k_m',
        label: 'Standard — 2.5 GB',
        url: 'https://huggingface.co/prism-ml/bonsai-4b-GGUF/resolve/main/bonsai-4b-Q4_K_M.gguf',
        bytes: Math.round(2.5 * GB),
        sha256: '',
        minMemoryBytes: 8 * GB,
        contextLength: 8192
      }
    ]
  }
]

/** The model an untouched embedded setup uses. */
export const DEFAULT_EMBEDDED_MODEL = 'bonsai-9b'

/**
 * Context window for a sideloaded file.
 *
 * A `.gguf` states its own trained context, but reading it means parsing the
 * header — and a value too large simply fails to allocate. 8192 is what every
 * catalogue entry uses and what current open models train at, so it is the
 * conservative guess rather than an arbitrary one.
 */
export const DEFAULT_SIDELOAD_CONTEXT = 8192

export function findModel(modelId: string): EmbeddedModel | null {
  return EMBEDDED_MODELS.find((model) => model.id === modelId) ?? null
}

export function findVariant(
  variantId: string
): { model: EmbeddedModel; variant: ModelVariant } | null {
  for (const model of EMBEDDED_MODELS) {
    const variant = model.variants.find((candidate) => candidate.id === variantId)
    if (variant) return { model, variant }
  }
  return null
}

/**
 * Whether a model setting names a file on disk rather than a catalogue entry.
 *
 * The escape hatch, and deliberately crude: anything with a path separator or a
 * `.gguf` suffix is a file. A catalogue id has neither, so the two cannot be
 * confused by a name someone types.
 */
export function isSideloadedModel(model: string): boolean {
  return model.includes('/') || model.includes('\\') || model.toLowerCase().endsWith('.gguf')
}

/**
 * The variant an embedded `model` setting resolves to.
 *
 * A setting may name a model (`bonsai-9b` — take its first variant, which is
 * the one the catalogue lists first for that reason) or a variant outright
 * (`bonsai-9b-q4_k_m`). Both spellings appear in saved projects because the
 * picker offers models and the manager offers variants.
 */
export function resolveVariant(model: string): ModelVariant | null {
  const byVariant = findVariant(model)
  if (byVariant) return byVariant.variant
  return findModel(model)?.variants[0] ?? null
}

export const modelStateSchema = z.enum(['absent', 'downloading', 'ready'])
export type ModelState = z.infer<typeof modelStateSchema>

/** What the manager shows for one variant. */
export const variantStatusSchema = z.object({
  variantId: z.string(),
  state: modelStateSchema,
  /** Bytes on disk: the whole file when ready, the partial when downloading. */
  bytesOnDisk: z.number().int().default(0),
  /**
   * Whether the file's digest was checked against the catalogue's. False when
   * the catalogue has no digest to check against — see `modelVariantSchema`.
   */
  verified: z.boolean().default(false),
  /** Null when this machine has enough memory; a sentence to show when it does not. */
  gate: z.string().nullable().default(null)
})
export type VariantStatus = z.infer<typeof variantStatusSchema>

/**
 * What choosing a model should do about it.
 *
 * Pure, and separate from the store that acts on it, because the interesting
 * part is the decision rather than the plumbing: a file already on this machine
 * needs nothing, a variant this machine cannot hold must be refused before any
 * bytes move, and everything else is a download. Getting that wrong wastes
 * either someone's bandwidth or their afternoon.
 */
export type ModelChoice =
  | { kind: 'ready' }
  | { kind: 'download'; variantId: string }
  | { kind: 'refuse'; reason: string }

export function modelChoice(model: string, statuses: readonly VariantStatus[]): ModelChoice {
  if (isSideloadedModel(model)) return { kind: 'ready' }

  const variant = resolveVariant(model)
  if (!variant) return { kind: 'refuse', reason: `"${model}" is not a model this build knows about.` }

  const status = statuses.find((candidate) => candidate.variantId === variant.id)
  // Already here, or already on its way — either way, pressing again should not
  // start a second transfer of the same file.
  if (status?.state === 'ready' || status?.state === 'downloading') return { kind: 'ready' }
  if (status?.gate) return { kind: 'refuse', reason: status.gate }
  return { kind: 'download', variantId: variant.id }
}

export const engineStateSchema = z.enum(['stopped', 'starting', 'running', 'error'])
export type EngineState = z.infer<typeof engineStateSchema>

export const llmStatusSchema = z.object({
  variants: z.array(variantStatusSchema),
  engine: z.object({
    state: engineStateSchema,
    /** Which variant or file is loaded; empty when nothing is. */
    model: z.string().default(''),
    message: z.string().default('')
  }),
  /** Total system memory, so the manager can explain a gate rather than just apply it. */
  totalMemoryBytes: z.number().int().default(0),
  /** False when no `llama-server` binary shipped for this platform. */
  runtimeAvailable: z.boolean().default(false)
})
export type LlmStatus = z.infer<typeof llmStatusSchema>

/** Download progress, pushed as it happens. */
export const llmProgressSchema = z.object({
  variantId: z.string(),
  receivedBytes: z.number().int(),
  totalBytes: z.number().int(),
  done: z.boolean().default(false),
  error: z.string().default('')
})
export type LlmProgress = z.infer<typeof llmProgressSchema>

/** Human-readable size, for a UI that talks about gigabytes constantly. */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} kB`
}

/**
 * Whether this machine can run a variant, and what to say when it cannot.
 *
 * Memory only. llama.cpp falls back to CPU on its own, so probing for a GPU
 * would gate on a guess rather than on a fact — and a wrong VRAM guess refuses
 * a model that would have worked.
 */
export function memoryGate(variant: ModelVariant, totalMemoryBytes: number): string | null {
  if (totalMemoryBytes <= 0) return null
  if (totalMemoryBytes >= variant.minMemoryBytes) return null
  return `Needs about ${formatBytes(variant.minMemoryBytes)} of memory; this machine has ${formatBytes(totalMemoryBytes)}.`
}
