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

  it('only the kinds whose formats have actually changed carry steps', () => {
    // The only formats to have changed since this machinery shipped. Any
    // *other* kind showing up with a step here is a signal, not a typo.
    const changed = new Set([
      'document',
      'manifest',
      'chats',
      'connections',
      'pdfHighlights',
      // Phase 15: the provisional flag, on records and on sources.
      'entities',
      'sources'
    ])
    for (const [kind, steps] of Object.entries(MIGRATIONS)) {
      if (changed.has(kind)) continue
      expect(steps).toEqual([])
    }
  })

  it('carries a v1 chats file forward, since both its steps are no-ops', () => {
    // Phase 8 (the `embedded` provider) and Phase 10b (`toolCalls`) each add
    // only defaulted fields. The version moving is the entire point: a build
    // that predates them renames an unparseable chats file to `.corrupt-*`,
    // which would lose every conversation in the project.
    const raw = { formatVersion: 1, chats: [{ id: 'c1', title: 'Hello' }] }
    const result = migrate('chats', raw)
    expect(result.tooNew).toBe(false)
    expect(result.migrated).toBe(true)
    expect(result.value).toEqual(raw)
  })

  it('refuses a chats file from a newer build rather than migrating it', () => {
    const result = migrate('chats', { formatVersion: FORMAT_VERSIONS.chats + 1 })
    expect(result.tooNew).toBe(true)
    expect(result.migrated).toBe(false)
  })

  it('carries a v1 manifest forward to current unchanged, since its one step is a no-op', () => {
    const raw = { formatVersion: 1, name: 'x' }
    const result = migrate('manifest', raw)
    expect(result).toEqual({ value: raw, migrated: true, tooNew: false })
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

describe('the connections file', () => {
  it('carries a v1 file forward, and refuses one from a newer build', () => {
    // The step is a no-op, and the version moving is the whole of its value: a
    // build that predates the `db` protocol fails the enum on a file naming
    // one, and `ConnectionStore.read` turns an unparseable file into "you have
    // no saved servers" — losing every profile, not only the new one.
    const forward = migrate('connections', { formatVersion: 1, connections: [{ id: 'a' }] })
    expect(forward.tooNew).toBe(false)
    expect(forward.migrated).toBe(true)

    const future = migrate('connections', { formatVersion: 99, connections: [] })
    expect(future.tooNew).toBe(true)
  })
})
