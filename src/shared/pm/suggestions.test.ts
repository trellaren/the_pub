import { describe, it, expect } from 'vitest'
import { resolveSuggestions, resolveSuggestionAt, listSuggestions, hasSuggestions } from './suggestions.js'
import { extractPlainText, countWords } from './extractText.js'
import { DELETION_MARK, INSERTION_MARK } from '../model/suggestion.js'
import type { PmDoc } from '../model/document.js'

function text(value: string, mark?: { type: string; authorId?: string }) {
  return {
    type: 'text',
    text: value,
    ...(mark
      ? { marks: [{ type: mark.type, attrs: { authorId: mark.authorId ?? 'marta', at: '2026-01-01' } }] }
      : {})
  }
}

function doc(...inline: unknown[]): PmDoc {
  return { type: 'doc', content: [{ type: 'paragraph', content: inline }] } as PmDoc
}

/**
 * "The harbour was quiet." with "very " suggested and "was " struck.
 *
 * The deleted run takes its trailing space with it, which is what a real
 * deletion of a word looks like — striking the word alone leaves two spaces
 * behind, in Word as much as here.
 */
const underReview = doc(
  text('The harbour '),
  text('was ', { type: DELETION_MARK }),
  text('very ', { type: INSERTION_MARK }),
  text('quiet.')
)

describe('resolveSuggestions', () => {
  it('accepting an insertion keeps the text and drops the mark', () => {
    const resolved = resolveSuggestions(doc(text('very ', { type: INSERTION_MARK })), true)
    expect(extractPlainText(resolved)).toBe('very ')
    expect(hasSuggestions(resolved)).toBe(false)
  })

  it('rejecting an insertion removes the text', () => {
    const resolved = resolveSuggestions(doc(text('a'), text('very ', { type: INSERTION_MARK })), false)
    expect(extractPlainText(resolved)).toBe('a')
  })

  it('accepting a deletion removes the text', () => {
    const resolved = resolveSuggestions(doc(text('a '), text('bad', { type: DELETION_MARK })), true)
    expect(extractPlainText(resolved)).toBe('a ')
  })

  it('rejecting a deletion keeps the text and drops the mark', () => {
    const resolved = resolveSuggestions(doc(text('a '), text('good', { type: DELETION_MARK })), false)
    expect(extractPlainText(resolved)).toBe('a good')
    expect(hasSuggestions(resolved)).toBe(false)
  })

  it('accept and reject are exact inverses over the same document', () => {
    // Accepting everything gives the reviewed text; rejecting everything gives
    // back exactly what the writer had. Nothing in between is reachable by
    // accident.
    expect(extractPlainText(resolveSuggestions(underReview, true))).toBe('The harbour very quiet.')
    expect(extractPlainText(resolveSuggestions(underReview, false))).toBe('The harbour was quiet.')
  })

  it('leaves other authors alone when filtered', () => {
    const shared = doc(
      text('one ', { type: INSERTION_MARK, authorId: 'marta' }),
      text('two ', { type: INSERTION_MARK, authorId: 'sam' }),
      text('three')
    )
    const resolved = resolveSuggestions(shared, true, { authorId: 'marta' })
    expect(listSuggestions(resolved).map((suggestion) => suggestion.authorId)).toEqual(['sam'])
  })

  it('strips every stacked mark of the accepted kind', () => {
    const stacked = doc({
      type: 'text',
      text: 'new',
      marks: [
        { type: INSERTION_MARK, attrs: { authorId: 'marta', at: '1' } },
        { type: INSERTION_MARK, attrs: { authorId: 'marta', at: '2' } }
      ]
    })
    expect(hasSuggestions(resolveSuggestions(stacked, true))).toBe(false)
    expect(hasSuggestions(resolveSuggestionAt(stacked, true, 0))).toBe(false)
  })

  it('resolves a suggestion nested inside a list item', () => {
    const nested = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [text('gone', { type: DELETION_MARK })] }]
            }
          ]
        }
      ]
    } as PmDoc
    expect(extractPlainText(resolveSuggestions(nested, true))).toBe('')
  })
})

describe('resolveSuggestionAt', () => {
  const sameAuthorTwice = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [text('a '), text('first', { type: INSERTION_MARK }), text(' b '), text('second', { type: INSERTION_MARK })] },
      { type: 'paragraph', content: [text('third', { type: INSERTION_MARK })] }
    ]
  } as PmDoc

  it('rejects only the chosen suggestion, not every one by that author', () => {
    const resolved = resolveSuggestionAt(sameAuthorTwice, false, 1)
    expect(extractPlainText(resolved)).toBe('a first b \nthird')
    expect(listSuggestions(resolved).map((suggestion) => suggestion.text)).toEqual(['first', 'third'])
  })

  it('accepts only the chosen suggestion', () => {
    const resolved = resolveSuggestionAt(sameAuthorTwice, true, 2)
    expect(listSuggestions(resolved).map((suggestion) => suggestion.text)).toEqual(['first', 'second'])
    expect(extractPlainText(resolved)).toContain('third')
  })

  it('resolves every fragment of a suggestion split across text nodes', () => {
    const split = doc(text('one ', { type: INSERTION_MARK }), text('two', { type: INSERTION_MARK }), text(' plain'))
    expect(extractPlainText(resolveSuggestionAt(split, false, 0))).toBe(' plain')
  })

  it('leaves the document alone for an index past the end', () => {
    expect(resolveSuggestionAt(underReview, true, 9)).toBe(underReview)
  })
})

describe('the document as-if-accepted', () => {
  it('counts an insertion and does not count a pending deletion', () => {
    // A manuscript's word count should be the manuscript's, not the argument
    // about it.
    expect(extractPlainText(underReview)).toBe('The harbour very quiet.')
    expect(countWords(underReview)).toBe(4)
  })

  it('keeps offsets aligned for everything measured in them', () => {
    // The equality this whole module rests on: what the walker reports and what
    // the text says agree, under review as much as anywhere else.
    const plain = extractPlainText(underReview)
    expect(plain.indexOf('very')).toBeGreaterThan(-1)
    expect(plain).not.toContain('was')
  })
})

describe('listSuggestions', () => {
  it('joins adjacent runs by the same author into one suggestion', () => {
    // The editor splits text nodes for its own reasons — a bold word inside an
    // insertion — and a panel listing each fragment is a panel nobody reads.
    const split = doc(
      text('one ', { type: INSERTION_MARK }),
      text('two', { type: INSERTION_MARK }),
      text(' plain')
    )
    const found = listSuggestions(split)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ mark: INSERTION_MARK, text: 'one two', blockIndex: 0 })
  })

  it('keeps two edits by the same author in one paragraph apart', () => {
    const twice = doc(text('one', { type: INSERTION_MARK }), text(' plain '), text('two', { type: INSERTION_MARK }))
    expect(listSuggestions(twice).map((suggestion) => suggestion.text)).toEqual(['one', 'two'])
  })

  it('reports which block each is in, so the panel can jump to it', () => {
    const twoBlocks = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [text('clean')] },
        { type: 'paragraph', content: [text('cut', { type: DELETION_MARK })] }
      ]
    } as PmDoc
    expect(listSuggestions(twoBlocks)[0]).toMatchObject({ blockIndex: 1, mark: DELETION_MARK })
  })
})
