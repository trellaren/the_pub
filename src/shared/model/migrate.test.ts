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

  it('every registered kind currently has zero migration steps', () => {
    // The point of this phase is the machinery, not a format change. A step
    // showing up here without a matching test for it is a signal, not a typo.
    for (const steps of Object.values(MIGRATIONS)) {
      expect(steps).toEqual([])
    }
  })

  it('is unfazed by a non-object payload', () => {
    expect(migrate('document', null)).toEqual({ value: null, migrated: false, tooNew: false })
    expect(migrate('document', 'not json')).toEqual({ value: 'not json', migrated: false, tooNew: false })
  })
})
