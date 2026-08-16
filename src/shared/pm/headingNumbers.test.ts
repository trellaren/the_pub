import { describe, it, expect } from 'vitest'
import { computeHeadingNumbers } from './headingNumbers.js'
import { BUILTIN_STYLES, type NamedStyle } from '../model/style.js'
import type { PmDoc } from '../model/document.js'

function heading(text: string, level: number, extra: Record<string, unknown> = {}) {
  return { type: 'heading', attrs: { level, ...extra }, content: [{ type: 'text', text }] }
}

function paragraph(text: string, attrs: Record<string, unknown> = {}) {
  return { type: 'paragraph', attrs, content: text ? [{ type: 'text', text }] : [] }
}

function numberedStyles(overrides: Partial<Record<'heading-1' | 'heading-2' | 'heading-3', NamedStyle['numbering']>>) {
  return BUILTIN_STYLES.map((style) => {
    const numbering = overrides[style.id as 'heading-1' | 'heading-2' | 'heading-3']
    return numbering ? { ...style, numbering } : style
  })
}

describe('computeHeadingNumbers', () => {
  it('numbers headings by outline level, nesting a second level under the first', () => {
    const styles = numberedStyles({
      'heading-1': { format: 'decimal', startAt: 1, levelText: '%1' },
      'heading-2': { format: 'decimal', startAt: 1, levelText: '%1.%2' }
    })
    const doc: PmDoc = {
      type: 'doc',
      content: [
        heading('Chapter One', 1),
        heading('Scene A', 2),
        heading('Scene B', 2),
        heading('Chapter Two', 1),
        heading('Scene A', 2)
      ]
    }
    expect([...computeHeadingNumbers(doc, styles).entries()]).toEqual([
      [0, '1'],
      [1, '1.1'],
      [2, '1.2'],
      [3, '2'],
      [4, '2.1']
    ])
  })

  it('resets a deeper counter when a shallower heading appears, numbered or not', () => {
    const styles = numberedStyles({ 'heading-2': { format: 'decimal', startAt: 1, levelText: '%2' } })
    const doc: PmDoc = { type: 'doc', content: [heading('A', 2), heading('Interlude', 1), heading('B', 2)] }
    // heading-1 has no numbering of its own here, but still starts a new subsection.
    expect([...computeHeadingNumbers(doc, styles).entries()]).toEqual([
      [0, '1'],
      [2, '1']
    ])
  })

  it('honours a startAt other than 1', () => {
    const styles = numberedStyles({ 'heading-1': { format: 'decimal', startAt: 5, levelText: '%1' } })
    const doc: PmDoc = { type: 'doc', content: [heading('First', 1), heading('Second', 1)] }
    expect([...computeHeadingNumbers(doc, styles).entries()]).toEqual([
      [0, '5'],
      [1, '6']
    ])
  })

  it('falls back to the skipped level’s own startAt for an <h3> directly under an <h1>', () => {
    const styles = numberedStyles({
      'heading-1': { format: 'decimal', startAt: 1, levelText: '%1' },
      'heading-2': { format: 'decimal', startAt: 1, levelText: '%1.%2' },
      'heading-3': { format: 'decimal', startAt: 1, levelText: '%1.%2.%3' }
    })
    const doc: PmDoc = { type: 'doc', content: [heading('Chapter', 1), heading('Deep section', 3)] }
    expect([...computeHeadingNumbers(doc, styles).entries()]).toEqual([
      [0, '1'],
      [1, '1.1.1']
    ])
  })

  it('leaves an unconfigured level unnumbered', () => {
    const doc: PmDoc = { type: 'doc', content: [heading('Untitled', 1)] }
    expect(computeHeadingNumbers(doc, BUILTIN_STYLES).size).toBe(0)
  })

  it('renders upper-roman, lower-alpha and upper-alpha formats', () => {
    const styles = numberedStyles({ 'heading-1': { format: 'upper-roman', startAt: 1, levelText: '%1' } })
    const doc: PmDoc = { type: 'doc', content: [heading('One', 1), heading('Two', 1), heading('Three', 1), heading('Four', 1)] }
    expect([...computeHeadingNumbers(doc, styles).values()]).toEqual(['I', 'II', 'III', 'IV'])

    const alphaStyles = numberedStyles({ 'heading-1': { format: 'lower-alpha', startAt: 1, levelText: '%1' } })
    const alphaDoc: PmDoc = { type: 'doc', content: [heading('One', 1), heading('Two', 1)] }
    expect([...computeHeadingNumbers(alphaDoc, alphaStyles).values()]).toEqual(['a', 'b'])
  })

  it('numbers a non-heading paragraph whose style opts into an outline level', () => {
    const styles: NamedStyle[] = [
      ...BUILTIN_STYLES,
      {
        id: 'part-title',
        name: 'Part Title',
        builtin: false,
        outlineLevel: 1,
        numbering: { format: 'upper-roman', startAt: 1, levelText: 'Part %1' },
        text: {},
        paragraph: {}
      }
    ]
    const doc: PmDoc = { type: 'doc', content: [paragraph('Part One', { styleId: 'part-title' })] }
    expect([...computeHeadingNumbers(doc, styles).entries()]).toEqual([[0, 'Part I']])
  })
})
