import { describe, it, expect } from 'vitest'
import { listCitations, citedSourceIds } from './citations.js'
import type { PmDoc, PmNode } from '../model/document.js'

function text(value: string): PmNode {
  return { type: 'text', text: value }
}

function paragraph(...content: PmNode[]): PmNode {
  return { type: 'paragraph', content }
}

function footnote(...paragraphs: PmNode[]): PmNode {
  return { type: 'footnote', content: paragraphs }
}

function citation(sourceIds: string[], attrs: Record<string, unknown> = {}): PmNode {
  return {
    type: 'field',
    attrs: { kind: 'citation', sourceIds, ...attrs },
    content: [text('…')]
  }
}

describe('listCitations', () => {
  it('finds inline citations with no note number', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [paragraph(text('As Smith argues '), citation(['smith19']), text('.'))]
    }
    const occurrences = listCitations(doc)
    expect(occurrences).toHaveLength(1)
    expect(occurrences[0]?.noteNumber).toBeNull()
  })

  it('numbers a citation by the footnote it sits inside, agreeing with listFootnotes', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        paragraph(text('First'), footnote(paragraph(citation(['a'])))),
        paragraph(text('Second'), footnote(paragraph(text('No citation here.')))),
        paragraph(text('Third'), footnote(paragraph(citation(['a']))))
      ]
    }
    const occurrences = listCitations(doc)
    expect(occurrences.map((occurrence) => occurrence.noteNumber)).toEqual([1, 3])
  })

  it('visits citations in document order regardless of nesting', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        paragraph(citation(['first'])),
        { type: 'heading', attrs: { level: 1 }, content: [citation(['second'])] }
      ]
    }
    const occurrences = listCitations(doc)
    expect(occurrences.map((occurrence) => occurrence.node.attrs?.sourceIds)).toEqual([['first'], ['second']])
  })

  it('ignores non-citation field kinds', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [paragraph({ type: 'field', attrs: { kind: 'toc' }, content: [text('Contents')] })]
    }
    expect(listCitations(doc)).toHaveLength(0)
  })
})

describe('citedSourceIds', () => {
  it('deduplicates, keeping the order of first citation', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [paragraph(citation(['b', 'a'])), paragraph(citation(['a', 'c']))]
    }
    expect(citedSourceIds(doc)).toEqual(['b', 'a', 'c'])
  })

  it('returns nothing when no citation cites any source', () => {
    const doc: PmDoc = { type: 'doc', content: [paragraph(text('No citations.'))] }
    expect(citedSourceIds(doc)).toEqual([])
  })
})
