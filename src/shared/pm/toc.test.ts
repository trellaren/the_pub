import { describe, it, expect } from 'vitest'
import { buildToc } from './toc.js'
import { BUILTIN_STYLES, type NamedStyle } from '../model/style.js'
import type { PmDoc } from '../model/document.js'

function heading(text: string, level: number, extra: Record<string, unknown> = {}) {
  return { type: 'heading', attrs: { level, ...extra }, content: [{ type: 'text', text }] }
}

function paragraph(text: string, attrs: Record<string, unknown> = {}) {
  return { type: 'paragraph', attrs, content: text ? [{ type: 'text', text }] : [] }
}

describe('buildToc', () => {
  it('collects headings in document order, with their level', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [heading('Chapter One', 1), paragraph('Some prose.'), heading('A scene', 2)]
    }
    expect(buildToc(doc, BUILTIN_STYLES)).toEqual([
      { blockIndex: 0, blockId: null, text: 'Chapter One', level: 1 },
      { blockIndex: 2, blockId: null, text: 'A scene', level: 2 }
    ])
  })

  it('carries an existing blockId through, rather than minting one', () => {
    const doc: PmDoc = { type: 'doc', content: [heading('Chapter One', 1, { blockId: 'b1' })] }
    expect(buildToc(doc, BUILTIN_STYLES)[0]?.blockId).toBe('b1')
  })

  it('skips a heading with no text', () => {
    const doc: PmDoc = { type: 'doc', content: [heading('', 1), heading('Real chapter', 1)] }
    expect(buildToc(doc, BUILTIN_STYLES).map((entry) => entry.text)).toEqual(['Real chapter'])
  })

  it('excludes ordinary body paragraphs', () => {
    const doc: PmDoc = { type: 'doc', content: [paragraph('Just prose.')] }
    expect(buildToc(doc, BUILTIN_STYLES)).toEqual([])
  })

  it('includes a paragraph whose style opts into the outline without being a heading node', () => {
    const styles: NamedStyle[] = [
      ...BUILTIN_STYLES,
      { id: 'part-title', name: 'Part Title', builtin: false, outlineLevel: 1, text: {}, paragraph: {} }
    ]
    const doc: PmDoc = { type: 'doc', content: [paragraph('Part One', { styleId: 'part-title' })] }
    expect(buildToc(doc, styles)).toEqual([{ blockIndex: 0, blockId: null, text: 'Part One', level: 1 }])
  })

  it('a heading style with no explicit outlineLevel still lands in the outline, at its headingLevel', () => {
    const styles: NamedStyle[] = [
      ...BUILTIN_STYLES,
      { id: 'callout', name: 'Callout', builtin: false, headingLevel: 2, text: {}, paragraph: {} }
    ]
    const doc: PmDoc = { type: 'doc', content: [heading('A callout', 2, { styleId: 'callout' })] }
    expect(buildToc(doc, styles)).toEqual([{ blockIndex: 0, blockId: null, text: 'A callout', level: 2 }])
  })

  it('resolves outlineLevel through a basedOn chain', () => {
    const styles: NamedStyle[] = [
      ...BUILTIN_STYLES,
      { id: 'base-outline', name: 'Base', builtin: false, outlineLevel: 3, text: {}, paragraph: {} },
      { id: 'derived', name: 'Derived', builtin: false, basedOn: 'base-outline', text: {}, paragraph: {} }
    ]
    const doc: PmDoc = { type: 'doc', content: [paragraph('Nested section', { styleId: 'derived' })] }
    expect(buildToc(doc, styles)[0]?.level).toBe(3)
  })

  it('falls back to a bare heading node’s own level when it carries no styleId', () => {
    const doc: PmDoc = { type: 'doc', content: [heading('Untitled heading', 4)] }
    expect(buildToc(doc, BUILTIN_STYLES)[0]?.level).toBe(4)
  })
})
