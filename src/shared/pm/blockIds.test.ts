import { describe, it, expect } from 'vitest'
import { collectBlockIds, dedupeBlockIds } from './blockIds.js'
import type { PmDoc } from '../model/document.js'

function paragraph(text: string, blockId?: string) {
  return { type: 'paragraph', attrs: blockId ? { blockId } : undefined, content: [{ type: 'text', text }] }
}

function sequentialIds(prefix = 'fresh') {
  let n = 0
  return () => `${prefix}-${++n}`
}

describe('collectBlockIds', () => {
  it('collects ids from top-level blocks', () => {
    const doc: PmDoc = { type: 'doc', content: [paragraph('a', 'b1'), paragraph('b', 'b2')] }
    expect(collectBlockIds(doc)).toEqual(new Set(['b1', 'b2']))
  })

  it('descends into nested blocks — a blockquote, a list item', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [paragraph('quoted', 'b1')]
        }
      ]
    }
    expect(collectBlockIds(doc)).toEqual(new Set(['b1']))
  })

  it('ignores node types that are not paragraph or heading', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [{ type: 'image', attrs: { blockId: 'not-a-block' } }]
    }
    expect(collectBlockIds(doc)).toEqual(new Set())
  })

  it('is empty for a document with no ids assigned', () => {
    const doc: PmDoc = { type: 'doc', content: [paragraph('a'), paragraph('b')] }
    expect(collectBlockIds(doc)).toEqual(new Set())
  })
})

describe('dedupeBlockIds', () => {
  it('leaves a document with unique ids untouched', () => {
    const doc: PmDoc = { type: 'doc', content: [paragraph('a', 'b1'), paragraph('b', 'b2')] }
    const result = dedupeBlockIds(doc, sequentialIds())
    expect(result.changed).toBe(false)
    expect(result.doc).toBe(doc)
  })

  it('reassigns every occurrence after the first', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [paragraph('a', 'dup'), paragraph('b', 'dup'), paragraph('c', 'dup')]
    }
    const result = dedupeBlockIds(doc, sequentialIds())
    expect(result.changed).toBe(true)
    const ids = (result.doc.content ?? []).map((node) => node.attrs?.blockId)
    expect(ids[0]).toBe('dup')
    expect(new Set(ids).size).toBe(3)
  })

  it('never produces a duplicate even against ids it just minted', () => {
    // A generator that repeats the collision twice before giving something
    // new — the fix has to keep drawing, not accept the first fresh-looking
    // answer.
    let calls = 0
    const flaky = () => {
      calls += 1
      return calls <= 2 ? 'dup' : `flaky-${calls}`
    }
    const doc: PmDoc = {
      type: 'doc',
      content: [paragraph('a', 'dup'), paragraph('b', 'dup'), paragraph('c', 'dup')]
    }
    const result = dedupeBlockIds(doc, flaky)
    const ids = (result.doc.content ?? []).map((node) => node.attrs?.blockId)
    expect(ids[0]).toBe('dup')
    expect(new Set(ids).size).toBe(3)
  })

  it('fixes a duplicate nested inside a blockquote against a top-level one', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [paragraph('a', 'dup'), { type: 'blockquote', content: [paragraph('quoted', 'dup')] }]
    }
    const result = dedupeBlockIds(doc, sequentialIds())
    expect(result.changed).toBe(true)
    const top = result.doc.content?.[0]?.attrs?.blockId
    const nested = result.doc.content?.[1]?.content?.[0]?.attrs?.blockId
    expect(top).toBe('dup')
    expect(nested).not.toBe('dup')
  })

  it('leaves blocks without an id alone', () => {
    const doc: PmDoc = { type: 'doc', content: [paragraph('a'), paragraph('b')] }
    const result = dedupeBlockIds(doc, sequentialIds())
    expect(result.changed).toBe(false)
    expect(result.doc).toBe(doc)
  })
})
