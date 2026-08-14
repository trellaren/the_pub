import { describe, it, expect } from 'vitest'
import { resolveStyle, BUILTIN_STYLES, type NamedStyle } from './style.js'

describe('resolveStyle', () => {
  it('inherits unset attributes from the basedOn chain', () => {
    const resolved = resolveStyle('block-quote', BUILTIN_STYLES)
    // Its own italic, plus Body's font family.
    expect(resolved?.text.italic).toBe(true)
    expect(resolved?.text.fontFamily).toBe('Georgia, serif')
  })

  it('lets a derived style override its parent', () => {
    const styles: NamedStyle[] = [
      { id: 'a', name: 'A', builtin: false, text: { fontSize: 12 }, paragraph: {} },
      { id: 'b', name: 'B', builtin: false, basedOn: 'a', text: { fontSize: 20 }, paragraph: {} }
    ]
    expect(resolveStyle('b', styles)?.text.fontSize).toBe(20)
  })

  it('carries the heading level down the chain', () => {
    expect(resolveStyle('chapter-title', BUILTIN_STYLES)?.headingLevel).toBe(1)
  })

  it('returns null for an unknown style', () => {
    expect(resolveStyle('nope', BUILTIN_STYLES)).toBeNull()
  })

  it('does not hang on a cyclic basedOn chain', () => {
    const styles: NamedStyle[] = [
      { id: 'a', name: 'A', builtin: false, basedOn: 'b', text: {}, paragraph: {} },
      { id: 'b', name: 'B', builtin: false, basedOn: 'a', text: { bold: true }, paragraph: {} }
    ]
    expect(resolveStyle('a', styles)).not.toBeNull()
  })
})
