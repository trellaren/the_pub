import { z } from 'zod'
import { MODEL_PINS } from './modelPins.js'

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
/**
 * Where a variant's weights come from.
 *
 * A repository, a **revision**, and a file — not a URL with `main` in it. The
 * revision is a commit hash, so it names one immutable tree: a URL pointing at
 * a branch downloads whatever is there today, which is a different file from
 * the one whose digest was pinned, and nothing would notice.
 *
 * This is also what makes pinning a command rather than a chore. `npm run
 * pin-models` reads the size and the LFS digest for exactly this revision and
 * writes them into `modelPins.ts`.
 */
export const modelSourceSchema = z.object({
  /** e.g. `unsloth/gemma-3n-E4B-it-GGUF`. */
  repo: z.string(),
  /** A commit hash. A branch name here would defeat the point — see above. */
  revision: z.string(),
  file: z.string()
})
export type ModelSource = z.infer<typeof modelSourceSchema>

export const modelVariantSchema = z.object({
  id: z.string(),
  /** What the picker shows, including the memory it wants. */
  label: z.string(),
  source: modelSourceSchema,
  /**
   * Size and digest of the file at `source.revision`.
   *
   * Not written by hand. Both come from `modelPins.ts`, which `npm run
   * pin-models` generates from the published artefacts — a digest somebody
   * typed from a web page is a digest nobody can re-derive, and one typed
   * wrongly makes every download look tampered with.
   *
   * A variant with no pin yet reports `unverified` rather than passing a check
   * that never ran, and `llm.pins.test.ts` names every such variant explicitly
   * so shipping one is an edit to a list rather than an oversight.
   */
  bytes: z.number().int(),
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
 * Two sizes of one family rather than a leaderboard: a writer on 8 GB should
 * get a private, offline assistant rather than a refusal, which is the whole
 * reason the gate is per variant rather than per feature. Gemma 3n is the
 * family because it was built for exactly this — running on the machine in
 * front of someone — and follows the structured replies the tools ask for.
 *
 * What is curated here is the choice: which models, which quantisations, and
 * how much memory each really needs. What is *not* here is `bytes` and
 * `sha256` — those are facts about published files rather than decisions, so
 * they are fetched by `npm run pin-models` into `modelPins.ts` and merged in
 * below. Nobody hand-copies a digest, and nobody forgets to.
 */
const CATALOGUE: EmbeddedModel[] = [
  {
    id: 'gemma-3n-e4b',
    name: 'Gemma 3n E4B',
    vendor: 'Google DeepMind, quantised by Unsloth',
    summary: 'The default. Built for devices, good at following instructions and at the tool calls the assistant makes. Comfortable on a laptop with 8 GB.',
    license: { name: 'Gemma Terms of Use', url: 'https://ai.google.dev/gemma/terms' },
    variants: [
      {
        id: 'gemma-3n-e4b-q4_k_m',
        label: 'Standard — 4.5 GB',
        source: {
          repo: 'unsloth/gemma-3n-E4B-it-GGUF',
          revision: '90fa8b0e431faeae50c305828bc260d6f71720e1',
          file: 'gemma-3n-E4B-it-Q4_K_M.gguf'
        },
        bytes: 0,
        sha256: '',
        minMemoryBytes: 8 * GB,
        contextLength: 8192
      },
      {
        id: 'gemma-3n-e4b-q8_0',
        label: 'High quality — 7.4 GB',
        source: {
          repo: 'unsloth/gemma-3n-E4B-it-GGUF',
          revision: '90fa8b0e431faeae50c305828bc260d6f71720e1',
          file: 'gemma-3n-E4B-it-Q8_0.gguf'
        },
        bytes: 0,
        sha256: '',
        minMemoryBytes: 12 * GB,
        contextLength: 8192
      }
    ]
  },
  {
    id: 'gemma-3n-e2b',
    name: 'Gemma 3n E2B',
    vendor: 'Google DeepMind, quantised by Unsloth',
    summary: 'The small one, for a modest machine. Fine for questions and rewrites; weaker on long chapters.',
    license: { name: 'Gemma Terms of Use', url: 'https://ai.google.dev/gemma/terms' },
    variants: [
      {
        id: 'gemma-3n-e2b-q4_k_m',
        label: 'Standard — 3 GB',
        source: {
          repo: 'unsloth/gemma-3n-E2B-it-GGUF',
          revision: 'd7bd20d510eff26f3f95260c50f032fee8931a35',
          file: 'gemma-3n-E2B-it-Q4_K_M.gguf'
        },
        bytes: 0,
        sha256: '',
        minMemoryBytes: 6 * GB,
        contextLength: 8192
      }
    ]
  }
]

/**
 * The catalogue, with the pinned facts merged in.
 *
 * Curation and pins are kept apart on purpose: one is a set of decisions a
 * person makes and reviews, the other is generated. Merging them here means a
 * pin can never disagree with the entry it belongs to, because there is only
 * one place the two meet.
 */
export const EMBEDDED_MODELS: EmbeddedModel[] = CATALOGUE.map((model) => ({
  ...model,
  variants: model.variants.map((variant) => {
    const pin = MODEL_PINS[variant.id]
    return pin ? { ...variant, bytes: pin.bytes, sha256: pin.sha256 } : variant
  })
}))

/**
 * Where to download a variant from.
 *
 * Built from the pinned revision rather than from a branch, so the bytes that
 * arrive are the bytes the digest was taken from.
 */
export function downloadUrl(variant: ModelVariant): string {
  const revision = variant.source.revision || 'main'
  return `https://huggingface.co/${variant.source.repo}/resolve/${revision}/${variant.source.file}`
}

/** Whether this build knows what the finished file should be. */
export function isPinned(variant: ModelVariant): boolean {
  return variant.sha256.length > 0 && variant.source.revision.length > 0
}

/** The model an untouched embedded setup uses. */
export const DEFAULT_EMBEDDED_MODEL = 'gemma-3n-e4b'

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
 * A setting may name a model (`gemma-3n-e4b` — take its first variant, which
 * is the one the catalogue lists first for that reason) or a variant outright
 * (`gemma-3n-e4b-q4_k_m`). Both spellings appear in saved projects because the
 * picker offers models and the manager offers variants.
 */
export function resolveVariant(model: string): ModelVariant | null {
  const byVariant = findVariant(model)
  if (byVariant) return byVariant.variant
  return findModel(model)?.variants[0] ?? null
}

/**
 * The variant a first launch should offer.
 *
 * The default model's standard build when this machine can hold it, else the
 * small model's — the whole point of two sizes. Null when nothing fits, which
 * the setup card says plainly rather than offering a download that would fail.
 */
export function defaultVariantFor(totalMemoryBytes: number): ModelVariant | null {
  const preferred = [findModel(DEFAULT_EMBEDDED_MODEL), ...EMBEDDED_MODELS].filter(
    (model): model is EmbeddedModel => model !== null
  )
  for (const model of preferred) {
    const standard = model.variants[0]
    if (standard && memoryGate(standard, totalMemoryBytes) === null) return standard
  }
  return null
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
