import { describe, it, expect } from 'vitest'
import {
  EMBEDDED_MODELS,
  DEFAULT_EMBEDDED_MODEL,
  findModel,
  findVariant,
  resolveVariant,
  isSideloadedModel,
  memoryGate,
  formatBytes
} from './llm.js'

const GB = 1024 ** 3

describe('the embedded model catalogue', () => {
  it('has a unique id for every model and every variant', () => {
    const modelIds = EMBEDDED_MODELS.map((model) => model.id)
    const variantIds = EMBEDDED_MODELS.flatMap((model) => model.variants.map((v) => v.id))
    expect(new Set(modelIds).size).toBe(modelIds.length)
    expect(new Set(variantIds).size).toBe(variantIds.length)
  })

  it('offers a default that actually exists', () => {
    expect(findModel(DEFAULT_EMBEDDED_MODEL)).not.toBeNull()
  })

  it('spans the hardware range rather than clustering at the top', () => {
    // The whole reason the gate is per variant: on a small machine something
    // must still be offered, or "embedded" means "embedded for people with
    // 32 GB" and the private-by-default promise only reaches them.
    const floors = EMBEDDED_MODELS.flatMap((model) =>
      model.variants.map((variant) => variant.minMemoryBytes)
    )
    expect(Math.min(...floors)).toBeLessThanOrEqual(8 * GB)
  })
})

describe('memoryGate', () => {
  const variant = { minMemoryBytes: 24 * GB } as Parameters<typeof memoryGate>[0]

  it('passes a machine with room to spare', () => {
    expect(memoryGate(variant, 32 * GB)).toBeNull()
  })

  it('refuses a machine that is too small, and says what it needs', () => {
    const gate = memoryGate(variant, 8 * GB)
    expect(gate).toContain('24.0 GB')
    expect(gate).toContain('8.0 GB')
  })

  it('does not refuse when the machine total is unknown', () => {
    // A gate that fires on a reading it does not have would refuse a model
    // that would have run.
    expect(memoryGate(variant, 0)).toBeNull()
  })
})

describe('resolving a model setting', () => {
  it('takes a model id to its first variant', () => {
    // The picker offers models and the manager offers variants, so both
    // spellings turn up in saved projects.
    expect(resolveVariant('bonsai-9b')?.id).toBe('bonsai-9b-q4_k_m')
  })

  it('takes a variant id to itself', () => {
    expect(resolveVariant('bonsai-27b-q8_0')?.id).toBe('bonsai-27b-q8_0')
  })

  it('resolves nothing for a name in neither list', () => {
    expect(resolveVariant('gpt-4o')).toBeNull()
    expect(findVariant('nope')).toBeNull()
  })
})

describe('isSideloadedModel', () => {
  it('treats a path or a .gguf as a file', () => {
    expect(isSideloadedModel('/models/my-model.gguf')).toBe(true)
    expect(isSideloadedModel('C:\\models\\my-model.gguf')).toBe(true)
    expect(isSideloadedModel('my-model.gguf')).toBe(true)
  })

  it('treats a catalogue id as a catalogue id', () => {
    // A catalogue id has neither a separator nor the suffix, so the two cannot
    // be confused by a name someone types.
    for (const model of EMBEDDED_MODELS) {
      expect(isSideloadedModel(model.id)).toBe(false)
      for (const variant of model.variants) expect(isSideloadedModel(variant.id)).toBe(false)
    }
  })
})

describe('formatBytes', () => {
  it('scales to the unit a person would use', () => {
    expect(formatBytes(16 * GB)).toBe('16.0 GB')
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB')
    expect(formatBytes(4 * 1024)).toBe('4 kB')
  })
})
