import { describe, it, expect } from 'vitest'
import { BUILTIN_STYLES, type NamedStyle } from '../../shared/model/style.js'
import {
  normalizeStyleKey,
  builtinForWordStyle,
  wordStyleFor,
  styleIdForName,
  reconcileStyles
} from './styleMap.js'

function incoming(patch: Partial<NamedStyle> & { id: string; name: string }): NamedStyle {
  return { builtin: false, text: {}, paragraph: {}, ...patch }
}

describe('normalizeStyleKey', () => {
  it('ignores the spelling differences between Word producers', () => {
    // Word writes w:styleId="Heading1" but displays "heading 1", and other
    // producers pick their own capitalisation.
    const key = normalizeStyleKey('Heading 1')
    expect(normalizeStyleKey('heading1')).toBe(key)
    expect(normalizeStyleKey('HEADING  1')).toBe(key)
    expect(normalizeStyleKey('Heading-1')).toBe(key)
  })
})

describe('builtinForWordStyle', () => {
  it('maps Word’s names onto the built-ins that already exist', () => {
    expect(builtinForWordStyle('Normal')).toBe('body')
    expect(builtinForWordStyle('Body Text')).toBe('body')
    expect(builtinForWordStyle('Heading 3')).toBe('heading-3')
    expect(builtinForWordStyle('Title')).toBe('chapter-title')
    expect(builtinForWordStyle('Intense Quote')).toBe('block-quote')
  })

  it('declines a style it has never heard of', () => {
    expect(builtinForWordStyle('Epigraph')).toBeNull()
  })
})

describe('wordStyleFor', () => {
  it('gives every built-in the name Word expects', () => {
    expect(wordStyleFor('heading-1', 'Heading 1')).toEqual({ id: 'Heading1', name: 'heading 1' })
    expect(wordStyleFor('body', 'Body')).toEqual({ id: 'Normal', name: 'Normal' })
  })

  it('keeps a user style’s own name and makes its id XML-safe', () => {
    expect(wordStyleFor('epigraph-2', 'Epigraph')).toEqual({ id: 'epigraph2', name: 'Epigraph' })
  })

  it('never produces an empty id', () => {
    expect(wordStyleFor('---', 'Odd').id).toBe('CustomStyle')
  })
})

describe('styleIdForName', () => {
  it('slugs the name, so the saved JSON says why a paragraph looks as it does', () => {
    expect(styleIdForName('Epigraph', [])).toBe('epigraph')
    expect(styleIdForName('Scene Break!', [])).toBe('scene-break')
  })

  it('suffixes rather than colliding', () => {
    // The styles panel uses `style-${Date.now().toString(36)}`, which collides
    // when an import mints a dozen ids inside the same millisecond.
    expect(styleIdForName('Epigraph', ['epigraph'])).toBe('epigraph-2')
    expect(styleIdForName('Epigraph', ['epigraph', 'epigraph-2'])).toBe('epigraph-3')
  })

  it('falls back for a name with nothing sluggable in it', () => {
    expect(styleIdForName('!!!', [])).toBe('imported-style')
  })
})

describe('reconcileStyles', () => {
  it('resolves a Word heading onto the project’s own, rather than adding a twin', () => {
    // An imported "Heading 1" that became a bespoke style called "Heading 1"
    // would look right and behave wrong: editing the project's Heading 1
    // afterwards would leave every imported chapter untouched.
    const { mapping, added } = reconcileStyles(
      [incoming({ id: 'Heading1', name: 'heading 1' })],
      BUILTIN_STYLES
    )
    expect(mapping.get('Heading1')).toBe('heading-1')
    expect(added).toEqual([])
  })

  it('adds a style the project has never seen', () => {
    const { mapping, added } = reconcileStyles(
      [incoming({ id: 'Epigraph', name: 'Epigraph', text: { italic: true } })],
      BUILTIN_STYLES
    )
    expect(mapping.get('Epigraph')).toBe('epigraph')
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ id: 'epigraph', name: 'Epigraph', builtin: false })
    expect(added[0]!.text.italic).toBe(true)
  })

  it('reuses a project style with the same name', () => {
    // Importing chapters two and three of the same book must not produce
    // Epigraph, Epigraph-2 and Epigraph-3.
    const existing = [...BUILTIN_STYLES, incoming({ id: 'epigraph', name: 'Epigraph' })]
    const { mapping, added } = reconcileStyles([incoming({ id: 'Epigraph', name: 'Epigraph' })], existing)
    expect(mapping.get('Epigraph')).toBe('epigraph')
    expect(added).toEqual([])
  })

  it('re-points basedOn and nextStyle at the ids they ended up with', () => {
    const { mapping, added } = reconcileStyles(
      [
        incoming({ id: 'Epigraph', name: 'Epigraph', basedOn: 'Normal', nextStyle: 'Verse' }),
        incoming({ id: 'Verse', name: 'Verse' })
      ],
      BUILTIN_STYLES
    )
    expect(mapping.get('Verse')).toBe('verse')
    const epigraph = added.find((style) => style.id === 'epigraph')!
    expect(epigraph.basedOn).toBe('body')
    expect(epigraph.nextStyle).toBe('verse')
  })

  it('drops a reference that led nowhere instead of keeping a dangling id', () => {
    const { added } = reconcileStyles(
      [incoming({ id: 'Epigraph', name: 'Epigraph', basedOn: 'DeletedStyle' })],
      BUILTIN_STYLES
    )
    expect(added[0]!.basedOn).toBeUndefined()
  })

  it('keeps two genuinely different styles apart', () => {
    const { mapping, added } = reconcileStyles(
      [incoming({ id: 'A', name: 'Epigraph' }), incoming({ id: 'B', name: 'Epigraph Alt' })],
      BUILTIN_STYLES
    )
    expect(mapping.get('A')).toBe('epigraph')
    expect(mapping.get('B')).toBe('epigraph-alt')
    expect(added).toHaveLength(2)
  })
})
