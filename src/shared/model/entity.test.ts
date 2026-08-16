import { describe, it, expect } from 'vitest'
import { storyEntitySchema, entityFileSchema, colorForIndex, ENTITY_COLORS } from './entity.js'

const MINIMAL = {
  id: 'e1',
  kind: 'character',
  name: 'Harlan',
  created: '2026-01-01T00:00:00.000Z',
  modified: '2026-01-01T00:00:00.000Z'
}

describe('storyEntitySchema', () => {
  it('fills in every optional collection', () => {
    const entity = storyEntitySchema.parse(MINIMAL)
    expect(entity.aliases).toEqual([])
    expect(entity.fields).toEqual([])
    expect(entity.relations).toEqual([])
    expect(entity.summary).toBe('')
    expect(entity.scan).toBe(true)
    expect(entity.notes).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
  })

  it('gives each parse its own arrays', () => {
    // zod hands back the *same* reference for a literal `.default([])`, and the
    // renderer mutates these — two records would silently share one alias list.
    const a = storyEntitySchema.parse(MINIMAL)
    const b = storyEntitySchema.parse({ ...MINIMAL, id: 'e2' })
    expect(a.aliases).not.toBe(b.aliases)
    expect(a.fields).not.toBe(b.fields)
    expect(a.relations).not.toBe(b.relations)

    a.aliases.push({ text: 'Har', scan: true })
    expect(b.aliases).toHaveLength(0)
  })

  it('gives each parse its own notes document', () => {
    const a = storyEntitySchema.parse(MINIMAL)
    const b = storyEntitySchema.parse({ ...MINIMAL, id: 'e2' })
    expect(a.notes).not.toBe(b.notes)
    expect(a.notes.content).not.toBe(b.notes.content)
  })

  it('defaults an alias to scannable', () => {
    const entity = storyEntitySchema.parse({ ...MINIMAL, aliases: [{ text: 'Har' }] })
    expect(entity.aliases[0]!.scan).toBe(true)
  })

  it('accepts a kind a project defines for itself, not just the fiction defaults', () => {
    // `kind` is project data (`manifest.entityKinds`), not a fixed enum — a
    // thesis project's "interviewee" is exactly as valid as "character".
    expect(storyEntitySchema.safeParse({ ...MINIMAL, kind: 'interviewee' }).success).toBe(true)
  })

  it('rejects a non-string kind', () => {
    expect(storyEntitySchema.safeParse({ ...MINIMAL, kind: 42 }).success).toBe(false)
  })
})

describe('entityFileSchema', () => {
  it('parses an empty object into an empty roster', () => {
    const file = entityFileSchema.parse({})
    expect(file.entities).toEqual([])
    expect(file.dismissed).toEqual([])
    expect(file.formatVersion).toBe(1)
  })

  it('gives each parse its own roster array', () => {
    const a = entityFileSchema.parse({})
    const b = entityFileSchema.parse({})
    expect(a.entities).not.toBe(b.entities)
    expect(a.dismissed).not.toBe(b.dismissed)
  })
})

describe('colorForIndex', () => {
  it('wraps around the palette', () => {
    expect(colorForIndex(0)).toBe(ENTITY_COLORS[0])
    expect(colorForIndex(ENTITY_COLORS.length)).toBe(ENTITY_COLORS[0])
  })
})
