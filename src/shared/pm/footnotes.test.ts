import { describe, it, expect } from 'vitest'
import { listFootnotes } from './footnotes.js'
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

describe('listFootnotes', () => {
  it('numbers footnotes in document order, starting at one', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        paragraph(text('First'), footnote(paragraph(text('One.'))), text(' sentence.')),
        paragraph(text('Second'), footnote(paragraph(text('Two.'))))
      ]
    }
    const entries = listFootnotes(doc)
    expect(entries.map((entry) => entry.number)).toEqual([1, 2])
    expect(entries.map((entry) => entry.text)).toEqual(['One.', 'Two.'])
  })

  it('finds a footnote nested inside a heading or table cell', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [text('Title'), footnote(paragraph(text('Aside.')))] },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [paragraph(text('Cell'), footnote(paragraph(text('Cell note.'))))] }
              ]
            }
          ]
        }
      ]
    }
    const entries = listFootnotes(doc)
    expect(entries.map((entry) => entry.text)).toEqual(['Aside.', 'Cell note.'])
  })

  it('joins a multi-paragraph footnote body with newlines', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [paragraph(text('Text'), footnote(paragraph(text('First para.')), paragraph(text('Second para.'))))]
    }
    expect(listFootnotes(doc)[0]?.text).toBe('First para.\nSecond para.')
  })

  it('returns nothing for a document with no footnotes', () => {
    const doc: PmDoc = { type: 'doc', content: [paragraph(text('Plain prose.'))] }
    expect(listFootnotes(doc)).toEqual([])
  })
})
