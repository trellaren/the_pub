import { describe, it, expect } from 'vitest'
import { normalizeDoi, normalizeIsbn, identify, crossrefToCsl, openLibraryToCsl } from './lookup.js'

/*
 * Captured payloads, trimmed to the fields the mapper reads. The request
 * itself is not exercised here on purpose — the gate runs with no network, and
 * a test that reaches Crossref would be a test of Crossref's uptime.
 */
const CROSSREF_ARTICLE = {
  DOI: '10.1038/nature12373',
  type: 'journal-article',
  title: ['Nanometre-scale thermometry in a living cell'],
  'container-title': ['Nature'],
  author: [
    { given: 'G.', family: 'Kucsko' },
    { given: 'P. C.', family: 'Maurer' }
  ],
  issued: { 'date-parts': [[2013, 7, 31]] },
  volume: '500',
  issue: '7460',
  page: '54-58',
  publisher: 'Springer Science and Business Media LLC',
  URL: 'http://dx.doi.org/10.1038/nature12373'
}

const CROSSREF_CORPORATE = {
  DOI: '10.5555/report',
  type: 'report',
  title: ['Annual Statistics'],
  author: [{ name: 'World Health Organization' }],
  issued: { 'date-parts': [[2021]] }
}

const OPEN_LIBRARY_BOOK = {
  title: 'The Left Hand of Darkness',
  authors: [{ name: 'Ursula K. Le Guin' }],
  publishers: [{ name: 'Ace Books' }],
  publish_places: [{ name: 'New York' }],
  publish_date: 'June 1, 1987',
  url: 'https://openlibrary.org/books/OL123M'
}

describe('normalizeDoi', () => {
  it('accepts a bare DOI', () => {
    expect(normalizeDoi('10.1038/nature12373')).toBe('10.1038/nature12373')
  })

  // People paste whatever their browser gave them.
  it('strips the prefixes a pasted DOI arrives with', () => {
    for (const input of [
      'https://doi.org/10.1038/nature12373',
      'http://dx.doi.org/10.1038/nature12373',
      'doi:10.1038/nature12373',
      '  10.1038/nature12373  '
    ]) {
      expect(normalizeDoi(input)).toBe('10.1038/nature12373')
    }
  })

  it('rejects something that is not a DOI', () => {
    expect(normalizeDoi('9780441478125')).toBeNull()
    expect(normalizeDoi('not a doi')).toBeNull()
    expect(normalizeDoi('10.1038')).toBeNull()
  })
})

describe('normalizeIsbn', () => {
  it('accepts ISBN-10 and ISBN-13, hyphenated or not', () => {
    expect(normalizeIsbn('978-0-441-47812-5')).toBe('9780441478125')
    expect(normalizeIsbn('9780441478125')).toBe('9780441478125')
    expect(normalizeIsbn('0-441-47812-3')).toBe('0441478123')
  })

  it('accepts the X check digit an ISBN-10 can end with', () => {
    expect(normalizeIsbn('043942089X')).toBe('043942089X')
  })

  it('rejects a number of the wrong length', () => {
    expect(normalizeIsbn('12345')).toBeNull()
    expect(normalizeIsbn('10.1038/nature12373')).toBeNull()
  })
})

describe('identify', () => {
  it('tells a DOI from an ISBN, so one field can take either', () => {
    expect(identify('10.1038/nature12373')).toBe('doi')
    expect(identify('978-0-441-47812-5')).toBe('isbn')
    expect(identify('something else')).toBeNull()
  })
})

describe('crossrefToCsl', () => {
  it('maps an article, unwrapping the arrays Crossref wraps its strings in', () => {
    const item = crossrefToCsl(CROSSREF_ARTICLE)!
    expect(item.id).toBe('10.1038/nature12373')
    expect(item.type).toBe('article-journal')
    expect(item.title).toBe('Nanometre-scale thermometry in a living cell')
    expect(item['container-title']).toBe('Nature')
    expect(item.volume).toBe('500')
    expect(item.page).toBe('54-58')
    expect(item.issued).toEqual({ 'date-parts': [[2013, 7, 31]] })
    expect(item.author).toEqual([
      { family: 'Kucsko', given: 'G.' },
      { family: 'Maurer', given: 'P. C.' }
    ])
  })

  // Crossref gives an organisation a `name`; CSL wants `literal`.
  it('maps a corporate author to a literal name', () => {
    const item = crossrefToCsl(CROSSREF_CORPORATE)!
    expect(item.author).toEqual([{ literal: 'World Health Organization' }])
    expect(item.type).toBe('report')
  })

  it('refuses a payload with no DOI rather than inventing an id', () => {
    expect(crossrefToCsl({ title: ['No identifier here'] })).toBeNull()
  })

  it('falls back to a generic type for a Crossref type it does not know', () => {
    expect(crossrefToCsl({ DOI: '10.1/x', type: 'component' })!.type).toBe('document')
  })
})

describe('openLibraryToCsl', () => {
  it('maps a book, splitting the author name it gives as one string', () => {
    const item = openLibraryToCsl(OPEN_LIBRARY_BOOK, '9780441478125')!
    expect(item.type).toBe('book')
    expect(item.title).toBe('The Left Hand of Darkness')
    expect(item.ISBN).toBe('9780441478125')
    expect(item.publisher).toBe('Ace Books')
    expect(item['publisher-place']).toBe('New York')
    expect(item.author).toEqual([{ family: 'Guin', given: 'Ursula K. Le' }])
  })

  /*
   * Open Library's dates are free text — "June 1, 1987", "1987", "c1987".
   * Only the year is taken; guessing a month from an ambiguous string would be
   * worse than having none.
   */
  it('takes only the year from a free-text publication date', () => {
    expect(openLibraryToCsl(OPEN_LIBRARY_BOOK, '9780441478125')!.issued).toEqual({
      'date-parts': [[1987]]
    })
  })

  it('joins a subtitle onto the title', () => {
    const item = openLibraryToCsl({ title: 'Main', subtitle: 'And More' }, '1')!
    expect(item.title).toBe('Main: And More')
  })

  it('refuses a record with no title', () => {
    expect(openLibraryToCsl({ publishers: [{ name: 'Nobody' }] }, '1')).toBeNull()
  })
})
