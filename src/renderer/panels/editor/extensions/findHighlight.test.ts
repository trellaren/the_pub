import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import { findMatches, remapMatches, type FindOptions } from './findHighlight.js'
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
