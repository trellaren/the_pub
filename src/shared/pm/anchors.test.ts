import { describe, it, expect } from 'vitest'
import {
  findAnchor,
  findAnchorLocations,
  collectAnchorIds,
  anchorSurfaceText,
  findTextOccurrences,
  applyAnchorMark
} from './anchors.js'
import { ANCHOR_MARK } from '../model/anchor.js'
import type { PmDoc } from '../model/document.js'

function anchoredText(text: string, anchorId: string) {
  return { type: 'text', text, marks: [{ type: ANCHOR_MARK, attrs: { anchorId } }] }
}

function plainText(text: string) {
  return { type: 'text', text }
}

describe('findAnchor', () => {
  it('locates a mark in the middle of a paragraph', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [plainText('The '), anchoredText('quick brown fox', 'n1'), plainText(' jumps')]
        }
      ]
    }
    const location = findAnchor(doc, 'n1')
    expect(location).toEqual({ blockIndex: 0, start: 4, end: 19, text: 'quick brown fox' })
  })

  it('finds text at the very start of a block', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [anchoredText('Once upon a time', 'n1'), plainText(', it began')] }]
    }
    const location = findAnchor(doc, 'n1')
    expect(location).toEqual({ blockIndex: 0, start: 0, end: 16, text: 'Once upon a time' })
  })

  it('finds text at the very end of a block', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [plainText('it ended, '), anchoredText('long ago', 'n1')] }]
    }
    const location = findAnchor(doc, 'n1')
    expect(location).toEqual({ blockIndex: 0, start: 10, end: 18, text: 'long ago' })
  })

  it('spans a bold run split across several text nodes', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            plainText('a '),
            { type: 'text', text: 'bold', marks: [{ type: ANCHOR_MARK, attrs: { anchorId: 'n1' } }, { type: 'bold' }] },
            { type: 'text', text: ' word', marks: [{ type: ANCHOR_MARK, attrs: { anchorId: 'n1' } }] }
          ]
        }
      ]
    }
    expect(anchorSurfaceText(doc, 'n1')).toBe('bold word')
  })

  it('returns null for an anchor that is not in the document', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('nothing here')] }] }
    expect(findAnchor(doc, 'missing')).toBeNull()
  })

  it('does not confuse two different anchors in the same block', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [anchoredText('first', 'n1'), plainText(' and '), anchoredText('second', 'n2')]
        }
      ]
    }
    expect(findAnchor(doc, 'n1')?.text).toBe('first')
    expect(findAnchor(doc, 'n2')?.text).toBe('second')
  })

  it('finds every block an anchor spans, in document order', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [anchoredText('first paragraph', 'n1')] },
        { type: 'paragraph', content: [anchoredText('second paragraph', 'n1')] }
      ]
    }
    const locations = findAnchorLocations(doc, 'n1')
    expect(locations).toHaveLength(2)
    expect(locations[0]).toMatchObject({ blockIndex: 0, text: 'first paragraph' })
    expect(locations[1]).toMatchObject({ blockIndex: 1, text: 'second paragraph' })
  })

  it('collapses raw newlines the same way search snippets do', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            plainText('before '),
            anchoredText('across', 'n1'),
            { type: 'hardBreak' },
            anchoredText('a break', 'n1'),
            plainText(' after')
          ]
        }
      ]
    }
    expect(anchorSurfaceText(doc, 'n1')).toBe('across a break')
  })
})

describe('collectAnchorIds', () => {
  it('collects every distinct anchor id in the document', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [anchoredText('a', 'n1')] },
        { type: 'paragraph', content: [anchoredText('b', 'n2'), anchoredText('c', 'n1')] }
      ]
    }
    expect(collectAnchorIds(doc)).toEqual(new Set(['n1', 'n2']))
  })

  it('is empty for a document with no anchors', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('plain')] }] }
    expect(collectAnchorIds(doc)).toEqual(new Set())
  })
})

describe('anchorSurfaceText', () => {
  it('returns null when the anchor is gone', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('plain')] }] }
    expect(anchorSurfaceText(doc, 'gone')).toBeNull()
  })

  it('is what a note would store for later recovery — stable across an edit before the anchor', () => {
    const before: PmDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [anchoredText('the important part', 'n1')] }]
    }
    const after: PmDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [plainText('A new sentence first. ')] },
        { type: 'paragraph', content: [anchoredText('the important part', 'n1')] }
      ]
    }
    expect(anchorSurfaceText(before, 'n1')).toBe(anchorSurfaceText(after, 'n1'))
  })
})

describe('findTextOccurrences', () => {
  it('finds a single occurrence', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('the quick fox')] }] }
    expect(findTextOccurrences(doc, 'quick')).toEqual([{ blockIndex: 0, start: 4, end: 9 }])
  })

  it('finds every occurrence, including more than one in the same block', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [plainText('a cat sat on a cat')] }]
    }
    expect(findTextOccurrences(doc, 'cat')).toEqual([
      { blockIndex: 0, start: 2, end: 5 },
      { blockIndex: 0, start: 15, end: 18 }
    ])
  })

  it('finds occurrences across several blocks', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [plainText('first the phrase here')] },
        { type: 'paragraph', content: [plainText('and the phrase again')] }
      ]
    }
    expect(findTextOccurrences(doc, 'the phrase')).toEqual([
      { blockIndex: 0, start: 6, end: 16 },
      { blockIndex: 1, start: 4, end: 14 }
    ])
  })

  it('is case-sensitive and exact — no fuzzy matching', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('The Cat sat')] }] }
    expect(findTextOccurrences(doc, 'the cat')).toEqual([])
  })

  it('returns nothing for empty text rather than matching everywhere', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('anything')] }] }
    expect(findTextOccurrences(doc, '')).toEqual([])
  })

  it('finds nothing in a document that no longer contains the text', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('completely different')] }] }
    expect(findTextOccurrences(doc, 'the important part')).toEqual([])
  })
})

describe('applyAnchorMark', () => {
  it('marks a range in the middle of a plain-text block', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('the quick brown fox')] }] }
    const result = applyAnchorMark(doc, 0, 4, 15, 'n1')
    expect(result).not.toBeNull()
    expect(findAnchor(result!, 'n1')).toEqual({ blockIndex: 0, start: 4, end: 15, text: 'quick brown' })
  })

  it('marks a range at the very start of a block', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('Once upon a time')] }] }
    const result = applyAnchorMark(doc, 0, 0, 4, 'n1')
    expect(findAnchor(result!, 'n1')).toEqual({ blockIndex: 0, start: 0, end: 4, text: 'Once' })
  })

  it('marks a range at the very end of a block', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('it ended long ago')] }] }
    const result = applyAnchorMark(doc, 0, 9, 17, 'n1')
    expect(findAnchor(result!, 'n1')).toEqual({ blockIndex: 0, start: 9, end: 17, text: 'long ago' })
  })

  it('marks a range spanning a bold run split across several text nodes', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [plainText('a '), { type: 'text', text: 'bold', marks: [{ type: 'bold' }] }, plainText(' word')] }
      ]
    }
    const result = applyAnchorMark(doc, 0, 2, 11, 'n1')
    expect(anchorSurfaceText(result!, 'n1')).toBe('bold word')
    // The bold mark on the middle run survives alongside the new anchor mark.
    const middle = result!.content![0]!.content![1]!
    expect(middle.marks?.some((m) => m.type === 'bold')).toBe(true)
    expect(middle.marks?.some((m) => m.type === ANCHOR_MARK)).toBe(true)
  })

  it('does not mutate the input document', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('the quick brown fox')] }] }
    const before = structuredClone(doc)
    applyAnchorMark(doc, 0, 4, 15, 'n1')
    expect(doc).toEqual(before)
  })

  it('returns null for a block index that does not exist', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('short')] }] }
    expect(applyAnchorMark(doc, 5, 0, 3, 'n1')).toBeNull()
  })

  it('returns null when the offsets are out of range', () => {
    const doc: PmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [plainText('short')] }] }
    expect(applyAnchorMark(doc, 0, 0, 999, 'n1')).toBeNull()
  })

  it('leaves other blocks untouched', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [plainText('first block')] },
        { type: 'paragraph', content: [plainText('second block')] }
      ]
    }
    const result = applyAnchorMark(doc, 1, 0, 6, 'n1')
    expect(result!.content![0]).toEqual(doc.content![0])
    expect(findAnchor(result!, 'n1')).toMatchObject({ blockIndex: 1, text: 'second' })
  })
})
