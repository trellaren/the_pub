import { describe, it, expect } from 'vitest'
import { parseBibtex, parseName, cleanValue } from './fromBibtex.js'
import {
  ZOTERO_BIB,
  JABREF_BIB,
  BIBDESK_BIB,
  MESSY_BIB,
  DUPLICATE_KEY_BIB
} from './fixtures.js'

describe('parseBibtex', () => {
  it('reads a Zotero article into CSL-JSON', () => {
    const { items, warnings } = parseBibtex(ZOTERO_BIB)
    expect(warnings).toEqual([])
    expect(items).toHaveLength(1)

    const item = items[0]!
    expect(item.id).toBe('smith2019attention')
    expect(item.type).toBe('article-journal')
    expect(item.title).toBe('Attention and the Reading Brain')
    expect(item['container-title']).toBe('Journal of Cognitive Science')
    expect(item.volume).toBe('14')
    expect(item.issue).toBe('3')
    expect(item.DOI).toBe('10.1234/jcs.2019.14.3.201')
    expect(item.author).toEqual([
      { family: 'Smith', given: 'Jane A.' },
      { family: 'Doe', given: 'John' }
    ])
  })

  // "201--229" is the TeX en-dash spelling; CSL wants a plain range.
  it('normalises a TeX page range', () => {
    expect(parseBibtex(ZOTERO_BIB).items[0]!.page).toBe('201-229')
  })

  it('reads a month macro into the date parts', () => {
    expect(parseBibtex(ZOTERO_BIB).items[0]!.issued).toEqual({ 'date-parts': [[2019, 3]]})
  })

  it('reads quoted values and "Given Family" order', () => {
    const { items } = parseBibtex(JABREF_BIB)
    const conference = items.find((item) => item.id === 'lee2020')!
    expect(conference.type).toBe('paper-conference')
    expect(conference['container-title']).toBe('Proceedings of the Conference on Machine Learning')
    expect(conference.author?.[0]).toEqual({ family: 'Lee', given: 'Kyung Hee' })
  })

  /*
   * A brace-wrapped author is an organisation. Splitting it into given/family
   * would render "World Health Organization" as an initial and a surname.
   */
  it('keeps a corporate author whole', () => {
    const { items } = parseBibtex(JABREF_BIB)
    const book = items.find((item) => item.id === 'who2021health')!
    expect(book.author).toEqual([{ literal: 'World Health Organization' }])
    expect(book.ISBN).toBe('978-92-4-002705-3')
    expect(book['publisher-place']).toBe('Geneva')
  })

  it('handles both spellings of a TeX accent', () => {
    const { items } = parseBibtex(BIBDESK_BIB)
    const thesis = items.find((item) => item.id === 'muller2018')!
    expect(thesis.type).toBe('thesis')
    expect(thesis.author).toEqual([{ family: 'Müller', given: 'Anna' }])

    const chapter = items.find((item) => item.id === 'oconnor2015')!
    expect(chapter.author).toEqual([{ family: "O'Connor", given: 'Seán' }])
  })

  it('unescapes an ampersand and a non-breaking tie', () => {
    const { items } = parseBibtex(BIBDESK_BIB)
    const chapter = items.find((item) => item.id === 'oconnor2015')!
    expect(chapter.title).toBe('Ships & Sailors')
    expect(chapter.publisher).toBe('Harbour Press')
  })

  it('skips @string, @comment and @preamble without complaining', () => {
    const { items, warnings } = parseBibtex(MESSY_BIB)
    expect(items.map((item) => item.id)).toEqual(['good2020', 'alsogood2021'])
    expect(warnings).toEqual([])
  })

  // Nested braces inside a field must not end the entry early.
  it('reads a title containing nested braces', () => {
    const { items } = parseBibtex(MESSY_BIB)
    expect(items.find((item) => item.id === 'alsogood2021')!.title).toBe('Braces Inside A Title Survive')
  })

  /*
   * Two entries collapsing into one id would mean a citation could never name
   * the second — worse than a renamed key, which is at least visible.
   */
  it('keeps both entries when two share a citation key, and says so', () => {
    const { items, warnings } = parseBibtex(DUPLICATE_KEY_BIB)
    expect(items.map((item) => item.title)).toEqual(['First', 'Second'])
    expect(new Set(items.map((item) => item.id)).size).toBe(2)
    expect(warnings.join(' ')).toContain('share the key')
  })

  it('returns nothing for an empty or non-BibTeX file rather than throwing', () => {
    expect(parseBibtex('').items).toEqual([])
    expect(parseBibtex('just some prose, no entries here').items).toEqual([])
  })

  it('reports an unterminated entry instead of hanging', () => {
    const { items, warnings } = parseBibtex('@article{broken2020,\n  title = {No closing brace')
    expect(items).toEqual([])
    expect(warnings.join(' ')).toContain('closing brace')
  })

  it('falls back to a generic type for an entry kind it does not know', () => {
    const { items } = parseBibtex('@dataset{d1, title = {Numbers}, year = {2022}}')
    expect(items[0]!.type).toBe('document')
    expect(items[0]!.title).toBe('Numbers')
  })

  it('prefers biblatex’s precise date over a bare year', () => {
    const { items } = parseBibtex('@article{d1, title = {T}, year = {2019}, date = {2019-04-07}}')
    expect(items[0]!.issued).toEqual({ 'date-parts': [[2019, 4, 7]] })
  })
})

describe('parseName', () => {
  it('reads "Family, Given"', () => {
    expect(parseName('Smith, Jane A.')).toEqual({ family: 'Smith', given: 'Jane A.' })
  })

  it('reads "Given Family"', () => {
    expect(parseName('Jane A. Smith')).toEqual({ family: 'Smith', given: 'Jane A.' })
  })

  it('treats a single word as a literal, not a bare surname', () => {
    expect(parseName('Aristotle')).toEqual({ literal: 'Aristotle' })
  })

  it('treats a braced name as an organisation', () => {
    expect(parseName('{Open Rights Group}')).toEqual({ literal: 'Open Rights Group' })
  })
})

describe('cleanValue', () => {
  it('drops protective braces but keeps their contents', () => {
    expect(cleanValue('The {DNA} of {Reading}')).toBe('The DNA of Reading')
  })

  it('collapses the whitespace a wrapped field arrives with', () => {
    expect(cleanValue('A title\n    split over lines')).toBe('A title split over lines')
  })

  it('leaves ordinary text alone', () => {
    expect(cleanValue('A Perfectly Ordinary Title')).toBe('A Perfectly Ordinary Title')
  })
})
