import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import {
  FindHighlight,
  findMatches,
  findPluginKey,
  getFindState,
  remapMatches,
  type FindOptions
} from './findHighlight.js'
import { Field } from './field.js'
import { Footnote } from './footnote.js'
import { Insertion, Deletion } from './suggestions.js'

const schema = getSchema([StarterKit])
const options: FindOptions = { term: 'cat', matchCase: false, wholeWord: true }

function stateOf(...texts: string[]): EditorState {
  return EditorState.create({
    doc: schema.nodeFromJSON({
      type: 'doc',
      content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
    })
  })
}

function expectRemapMatchesFullScan(state: EditorState, edit: (state: EditorState) => Transaction) {
  const before = findMatches(state.doc, options)
  const transaction = edit(state)
  expect(remapMatches(before, transaction, options)).toEqual(findMatches(transaction.doc, options))
}

describe('find decorations', () => {
  const plugins = FindHighlight.config.addProseMirrorPlugins!.call({} as never)
  function withFind(...texts: string[]): EditorState {
    const base = EditorState.create({ doc: stateOf(...texts).doc, plugins })
    return base.apply(base.tr.setMeta(findPluginKey, { options }))
  }
  const ranges = (state: EditorState) =>
    getFindState(state)
      .decorations.find()
      .map((decoration) => [decoration.from, decoration.to])
  const matchRanges = (state: EditorState) => getFindState(state).matches.map((match) => [match.from, match.to])

  it('keeps the same set across a selection-only transaction', () => {
    const state = withFind('a cat', 'cat')
    const moved = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)))
    expect(getFindState(moved).decorations).toBe(getFindState(state).decorations)
  })

  it('agrees with the matches after edits inside and outside them', () => {
    let state = withFind('a cat', 'the dog', 'cat')
    expect(ranges(state)).toEqual(matchRanges(state))
    state = state.apply(state.tr.insertText('big ', 9))
    expect(ranges(state)).toEqual(matchRanges(state))
    state = state.apply(state.tr.insertText('cat ', 8))
    expect(ranges(state)).toEqual(matchRanges(state))
    expect(getFindState(state).matches).toHaveLength(3)
  })
})

describe('remapMatches', () => {
  it('maps matches in untouched blocks and rescans the edited one', () => {
    const state = stateOf('a cat', 'the dog', 'cat and cat')
    expectRemapMatchesFullScan(state, (s) => s.tr.insertText('cat ', 8))
  })

  it('drops a match the edit broke and finds one it made', () => {
    const state = stateOf('a cat', 'cats')
    expectRemapMatchesFullScan(state, (s) => s.tr.delete(11, 12))
    expectRemapMatchesFullScan(state, (s) => s.tr.insertText('s', 6))
  })

  it('handles block joins and deleted blocks', () => {
    const state = stateOf('one cat', 'two', 'cat three')
    expectRemapMatchesFullScan(state, (s) => s.tr.delete(8, 10))
    expectRemapMatchesFullScan(state, (s) => s.tr.delete(9, 14))
  })
})

describe('findMatches agrees with the shared text walker', () => {
  const rich = getSchema([StarterKit, Field, Footnote, Insertion, Deletion])
  const doc = rich.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          { type: 'field', attrs: { kind: 'ref' }, content: [{ type: 'text', text: 'Chapter cat' }] },
          { type: 'footnote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a cat note' }] }] },
          { type: 'text', text: ' ca' },
          { type: 'text', text: 'xx', marks: [{ type: 'deletion', attrs: { authorId: 'r' } }] },
          { type: 'text', text: 't' }
        ]
      }
    ]
  })

  it('finds field text, skips footnote bodies and reads past pending deletions', () => {
    const found = findMatches(doc, options).map((match) => doc.textBetween(match.from, match.to))
    expect(found).toEqual(['cat', 'caxxt'])
  })
})
