import { describe, it, expect } from 'vitest'
import { parseRis } from './fromRis.js'
import { SCOPUS_RIS, ENDNOTE_RIS } from './fixtures.js'

describe('parseRis', () => {
  it('reads a Scopus journal record into CSL-JSON', () => {
    const { items, warnings } = parseRis(SCOPUS_RIS)
    expect(warnings).toEqual([])
    expect(items).toHaveLength(2)

    const article = items[0]!
    expect(article.type).toBe('article-journal')
    expect(article.title).toBe('Attention and the Reading Brain')
    expect(article['container-title']).toBe('Journal of Cognitive Science')
    expect(article.volume).toBe('14')
    expect(article.issue).toBe('3')
    expect(article.DOI).toBe('10.1234/jcs.2019.14.3.201')
    expect(article.issued).toEqual({ 'date-parts': [[2019]] })
  })

  it('joins the start and end page tags into one range', () => {
    expect(parseRis(SCOPUS_RIS).items[0]!.page).toBe('201-229')
  })

  it('collects every repeated author tag, in order', () => {
    expect(parseRis(SCOPUS_RIS).items[0]!.author).toEqual([
      { family: 'Smith', given: 'Jane A.' },
      { family: 'Doe', given: 'John' }
    ])
  })

  it('keeps a single-token author whole rather than reading it as a surname', () => {
    const book = parseRis(SCOPUS_RIS).items[1]!
    expect(book.type).toBe('book')
    expect(book.author).toEqual([{ literal: 'World Health Organization' }])
    expect(book.ISBN).toBe('978-92-4-002705-3')
  })

  /*
   * EndNote writes `T1`/`T2`/`A1` where Scopus writes `TI`/`JO`/`AU`. Both are
   * ordinary files someone will drop on this, so the tags are synonyms.
   */
  it('reads EndNote’s tag spellings', () => {
    const { items } = parseRis(ENDNOTE_RIS)
    const chapter = items[0]!
    expect(chapter.type).toBe('chapter')
    expect(chapter.title).toBe('Ships and Sailors')
    expect(chapter['container-title']).toBe('A History of the Sea')
    expect(chapter.author).toEqual([{ family: "O'Connor", given: 'Sean' }])
  })

  it('reads a slash-separated date down to the day', () => {
    expect(parseRis(ENDNOTE_RIS).items[0]!.issued).toEqual({ 'date-parts': [[2015, 6, 1]] })
  })

  // RIS wraps long fields onto untagged continuation lines.
  it('joins a wrapped field back into one value', () => {
    expect(parseRis(ENDNOTE_RIS).items[0]!.abstract).toBe(
      'A chapter about ships and the people who sailed them.'
    )
  })

  it('gives every record a distinct id', () => {
    const ids = parseRis(SCOPUS_RIS).items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.length > 0)).toBe(true)
  })

  it('accepts a final record with no ER terminator', () => {
    const { items } = parseRis('TY  - JOUR\nTI  - Unterminated\nPY  - 2020')
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe('Unterminated')
  })

  it('returns nothing for an empty or non-RIS file rather than throwing', () => {
    expect(parseRis('').items).toEqual([])
    expect(parseRis('nothing tagged in here at all').items).toEqual([])
  })

  it('skips a record with neither title nor author, and says so', () => {
    const { items, warnings } = parseRis('TY  - JOUR\nVL  - 3\nER  -\n')
    expect(items).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('falls back to a generic type for a reference type it does not know', () => {
    const { items } = parseRis('TY  - DATA\nTI  - Numbers\nPY  - 2022\nER  -\n')
    expect(items[0]!.type).toBe('document')
  })
})
