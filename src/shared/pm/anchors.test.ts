import { describe, it, expect } from 'vitest'
import { findAnchor, findAnchorLocations, collectAnchorIds, anchorSurfaceText } from './anchors.js'
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
