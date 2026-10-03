import { describe, it, expect } from 'vitest'
import { isTrivial, unionProvenance, excerptOf, type ProvenanceEntry } from './provenance.js'

describe('isTrivial', () => {
  it('counts a misspelling, a case change or a punctuation change as trivial', () => {
    expect(isTrivial('recieved', 'received')).toBe(true)
    expect(isTrivial('the Harbour', 'the harbour')).toBe(true)
    expect(isTrivial('quiet,', 'quiet;')).toBe(true)
    expect(isTrivial('its', "it's")).toBe(true)
  })

  it('does not count a change of words, a reordering or an insertion as trivial', () => {
    expect(isTrivial('there', 'over there')).toBe(false)
    expect(isTrivial('quiet', 'silent')).toBe(false)
    expect(isTrivial('the harbour was quiet', 'the harbour lay quiet')).toBe(false)
    expect(isTrivial('', 'x')).toBe(false)
    expect(isTrivial('x', '')).toBe(false)
  })
})

describe('unionProvenance', () => {
  const entry = (id: string): ProvenanceEntry => ({
    id,
    runId: 'r',
    authorId: 'assistant-a',
    model: 'm',
    at: '2026-10-02T00:00:00.000Z',
    mode: 'direct',
    blockIndex: 0,
    chars: 3,
    excerpt: 'abc',
    reason: ''
  })

  it('keeps everything the file already had, in order, and adds what is new', () => {
    expect(unionProvenance([entry('a'), entry('b')], [entry('b'), entry('c')])!.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('cannot drop an entry by writing a shorter list', () => {
    expect(unionProvenance([entry('a'), entry('b')], [])!.map((e) => e.id)).toEqual(['a', 'b'])
    expect(unionProvenance([entry('a')], undefined)!.map((e) => e.id)).toEqual(['a'])
  })

  it('leaves a document that never had a log without one', () => {
    expect(unionProvenance(undefined, undefined)).toBeUndefined()
    expect(unionProvenance(undefined, [entry('a')])!.map((e) => e.id)).toEqual(['a'])
  })
})

describe('excerptOf', () => {
  it('flattens whitespace and clips long text', () => {
    expect(excerptOf('  a\n\n b ')).toBe('a b')
    expect(excerptOf('x'.repeat(100))).toHaveLength(80)
    expect(excerptOf('x'.repeat(100)).endsWith('…')).toBe(true)
  })
})
