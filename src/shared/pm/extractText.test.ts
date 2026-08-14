import { describe, it, expect } from 'vitest'
import { extractBlocks, extractPlainText, countWords, firstLine } from './extractText.js'
import type { PmDoc } from '../model/document.js'

const doc: PmDoc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The rain in Spain' }] },
    { type: 'paragraph' },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'A ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'stormy' },
        { type: 'text', text: ' night' }
      ]
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] }
      ]
    }
  ]
}

describe('extractBlocks', () => {
  it('indexes blocks by their position in the document', () => {
    const blocks = extractBlocks(doc)
    expect(blocks.map((block) => block.index)).toEqual([0, 1, 2, 3])
    expect(blocks[0]?.text).toBe('The rain in Spain')
  })

  it('joins text split across marks without inserting separators', () => {
    // A search for "stormy night" must match even though bold splits the text
    // into three ProseMirror nodes.
    expect(extractBlocks(doc)[2]?.text).toBe('A stormy night')
  })

  it('separates nested block content so words do not run together', () => {
    expect(extractBlocks(doc)[3]?.text).toBe('first second')
  })

  it('keeps empty blocks so later indices stay aligned with the document', () => {
    expect(extractBlocks(doc)[1]).toEqual({ index: 1, type: 'paragraph', text: '' })
  })
})

describe('countWords', () => {
  it('counts words across the document', () => {
    // 4 + 0 + 3 + 2 across the four blocks.
    expect(countWords(doc)).toBe(9)
  })

  it('treats hyphenated and apostrophised words as one', () => {
    expect(countWords("it's a well-lit room")).toBe(4)
  })

  it('ignores punctuation-only content', () => {
    expect(countWords('— … !')).toBe(0)
  })
})

describe('extractPlainText', () => {
  it('separates top-level blocks with newlines', () => {
    expect(extractPlainText(doc).split('\n')[0]).toBe('The rain in Spain')
  })
})

describe('firstLine', () => {
  it('skips empty blocks', () => {
    const empty: PmDoc = { type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: 'Chapter One' }] }] }
    expect(firstLine(empty)).toBe('Chapter One')
  })

  it('returns an empty string for an empty document', () => {
    expect(firstLine({ type: 'doc', content: [] })).toBe('')
  })
})
