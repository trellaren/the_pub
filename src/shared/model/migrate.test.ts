import { describe, it, expect } from 'vitest'
import { migrate, MIGRATIONS } from './migrate.js'
import { FORMAT_VERSIONS } from '../constants.js'

describe('migrate', () => {
  it('passes a current-version file through unchanged', () => {
    const raw = { formatVersion: FORMAT_VERSIONS.document, title: 'x' }
    const result = migrate('document', raw)
    expect(result).toEqual({ value: raw, migrated: false, tooNew: false })
  })

  it('flags a file newer than this build without touching it', () => {
    const raw = { formatVersion: FORMAT_VERSIONS.document + 1, title: 'x' }
    const result = migrate('document', raw)
    expect(result.tooNew).toBe(true)
    expect(result.migrated).toBe(false)
    expect(result.value).toBe(raw)
  })

  it('treats a file with no formatVersion as current, not too new', () => {
    const raw = { title: 'no version stamped yet' }
    const result = migrate('document', raw)
    expect(result.tooNew).toBe(false)
    expect(result.migrated).toBe(false)
  })

  it('every kind but document currently has zero migration steps', () => {
    // Phase 3 is the first format change since this machinery shipped —
    // `document` earning a step here is expected. Any other kind showing up
    // with one is a signal, not a typo.
    for (const [kind, steps] of Object.entries(MIGRATIONS)) {
      if (kind === 'document') continue
      expect(steps).toEqual([])
    }
  })

  it('carries a v1 document forward to current unchanged, since every step is a no-op', () => {
    const raw = { formatVersion: 1, title: 'x' }
    const result = migrate('document', raw)
    expect(result).toEqual({ value: raw, migrated: true, tooNew: false })
  })

  it('carries a v2 document forward to v3 unchanged', () => {
    const raw = { formatVersion: 2, title: 'x' }
    const result = migrate('document', raw)
    expect(result).toEqual({ value: raw, migrated: true, tooNew: false })
  })

  it('is unfazed by a non-object payload', () => {
    expect(migrate('document', null)).toEqual({ value: null, migrated: false, tooNew: false })
    expect(migrate('document', 'not json')).toEqual({ value: 'not json', migrated: false, tooNew: false })
  })
})
