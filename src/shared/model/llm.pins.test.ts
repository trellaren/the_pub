import { describe, it, expect } from 'vitest'
import { EMBEDDED_MODELS, downloadUrl, isPinned } from './llm.js'
import { MODEL_PINS } from './modelPins.js'

/**
 * Every variant this build cannot verify, named.
 *
 * The point of the list is that it is a list. An unpinned variant is a real
 * state — nobody can pin a digest for a file that has not been published — but
 * it must never be a *quiet* one, so shipping with one is an edit to this array
 * with a reason beside it rather than an empty string nobody noticed.
 *
 * To clear an entry: put the file's commit hash in the catalogue's `source`,
 * run `npm run pin-models`, and delete the line.
 */
const UNPINNED: { id: string; why: string }[] = [
  { id: 'bonsai-27b-q4_k_m', why: 'awaiting the published release artefact' },
  { id: 'bonsai-27b-q8_0', why: 'awaiting the published release artefact' },
  { id: 'bonsai-9b-q4_k_m', why: 'awaiting the published release artefact' },
  { id: 'bonsai-4b-q4_k_m', why: 'awaiting the published release artefact' }
]

const variants = EMBEDDED_MODELS.flatMap((model) => model.variants)

describe('the model catalogue', () => {
  it('names a source for every variant, so a pin can be resolved without a person', () => {
    for (const variant of variants) {
      expect(variant.source.repo, variant.id).not.toBe('')
      expect(variant.source.file, variant.id).toMatch(/\.gguf$/i)
    }
  })

  it('accounts for every unpinned variant explicitly', () => {
    const unpinned = variants.filter((variant) => !isPinned(variant)).map((variant) => variant.id)
    expect(unpinned.sort()).toEqual(UNPINNED.map((entry) => entry.id).sort())
    for (const entry of UNPINNED) expect(entry.why).not.toBe('')
  })

  it('pins only variants the catalogue actually has', () => {
    // A pin left behind after a variant is renamed or dropped would sit there
    // looking authoritative and describing nothing.
    const known = new Set(variants.map((variant) => variant.id))
    for (const id of Object.keys(MODEL_PINS)) expect(known.has(id), id).toBe(true)
  })

  it('pins a real digest and a real size, or nothing at all', () => {
    for (const [id, pin] of Object.entries(MODEL_PINS)) {
      expect(pin.sha256, id).toMatch(/^[0-9a-f]{64}$/)
      expect(pin.bytes, id).toBeGreaterThan(0)
    }
  })

  it('downloads from the pinned revision, never from a branch', () => {
    // A URL with `main` in it fetches whatever is there today, which is a
    // different file from the one the digest was taken from — and nothing
    // downstream could tell.
    for (const variant of variants.filter(isPinned)) {
      expect(downloadUrl(variant), variant.id).toContain(variant.source.revision)
      expect(downloadUrl(variant), variant.id).not.toContain('/resolve/main/')
    }
  })

  it('falls back to the default branch only while a variant is unpinned', () => {
    const unpinned = variants.find((variant) => !isPinned(variant))
    if (!unpinned) return
    expect(downloadUrl(unpinned)).toContain('/resolve/main/')
  })
})
