import { describe, it, expect } from 'vitest'
import { generateStyleSheet, defaultStyleFor } from './namedStyles.js'
import { BUILTIN_STYLES, type NamedStyle } from '@shared/model/style.js'

describe('generateStyleSheet', () => {
  it('emits a class rule per style', () => {
    const css = generateStyleSheet(BUILTIN_STYLES)
    expect(css).toContain('.pub-style-body {')
    expect(css).toContain('.pub-style-chapter-title {')
  })

  it('resolves inherited attributes into the rule', () => {
    // Block Quote is based on Body, so it must carry Body's font family.
    const rule = generateStyleSheet(BUILTIN_STYLES).split('\n\n').find((block) => block.startsWith('.pub-style-block-quote'))
    expect(rule).toContain('font-family: Georgia, serif')
    expect(rule).toContain('font-style: italic')
  })

  it('styles blocks that carry no style id, so imported text still looks right', () => {
    const css = generateStyleSheet(BUILTIN_STYLES)
    expect(css).toContain('.pub-prose p:not([data-style])')
    expect(css).toContain('.pub-prose h1:not([data-style])')
    expect(css).toContain('.pub-prose h6:not([data-style])')
  })

  it('never uses !important, so direct formatting can still win', () => {
    expect(generateStyleSheet(BUILTIN_STYLES)).not.toContain('!important')
  })

  it('converts point-valued attributes to pt units', () => {
    const styles: NamedStyle[] = [
      {
        id: 'x',
        name: 'X',
        builtin: false,
        text: { fontSize: 14 },
        paragraph: { spaceAfter: 8, firstLineIndent: 24 }
      }
    ]
    const css = generateStyleSheet(styles, 'x')
    expect(css).toContain('font-size: 14pt')
    expect(css).toContain('margin-bottom: 8pt')
    expect(css).toContain('text-indent: 24pt')
  })

  it('produces no fallback rules when the project has no styles', () => {
    expect(generateStyleSheet([], 'body')).toBe('')
  })
})

describe('defaultStyleFor', () => {
  it('maps a heading to the style named for its level', () => {
    expect(defaultStyleFor('heading', 2, BUILTIN_STYLES, 'body')?.id).toBe('heading-2')
  })

  it('prefers heading-1 over another style that also renders as h1', () => {
    // Chapter Title is also headingLevel 1; the numbered style must win so the
    // mapping is predictable.
    expect(defaultStyleFor('heading', 1, BUILTIN_STYLES, 'body')?.id).toBe('heading-1')
  })

  it('falls back to the project default for paragraphs', () => {
    expect(defaultStyleFor('paragraph', undefined, BUILTIN_STYLES, 'indented-body')?.id).toBe('indented-body')
  })

  it('falls back to the first style when the configured default is missing', () => {
    expect(defaultStyleFor('paragraph', undefined, BUILTIN_STYLES, 'nonexistent')?.id).toBe('body')
  })
})
