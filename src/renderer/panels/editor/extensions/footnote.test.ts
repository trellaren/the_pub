import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import type { DecorationSet } from '@tiptap/pm/view'
import { Footnote, footnoteDecorations, nextFootnoteViewState } from './footnote.js'

const schema = getSchema([StarterKit, Footnote])

const note = (text: string) => ({
  type: 'footnote',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const state = EditorState.create({
  doc: schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'First' }, note('one'), { type: 'text', text: ' line.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second' }, note('two')] }
    ]
  })
})

function summary(set: DecorationSet, doc: EditorState['doc']) {
  return set
    .find(0, doc.content.size)
    .map((decoration) => ({ from: decoration.from, to: decoration.to, spec: (decoration as unknown as { type: { attrs: unknown } }).type.attrs }))
}

function expectIncrementalMatchesRebuild(transaction: Transaction, openPos: number | null = null) {
  const value = { openPos, decorations: footnoteDecorations(state.doc, openPos) }
  const next = nextFootnoteViewState(transaction, value, transaction.doc)
  expect(summary(next.decorations, transaction.doc)).toEqual(
    summary(footnoteDecorations(transaction.doc, next.openPos), transaction.doc)
  )
  return next
}

describe('footnote decorations', () => {
  it('maps rather than rebuilds for an edit away from any footnote', () => {
    const transaction = state.tr.insertText('Very ', 1)
    const value = { openPos: null, decorations: footnoteDecorations(state.doc, null) }
    expectIncrementalMatchesRebuild(transaction)
    expect(nextFootnoteViewState(state.tr, value, state.doc)).toBe(value)
  })

  it('keeps the open footnote marked as it moves', () => {
    const next = expectIncrementalMatchesRebuild(state.tr.insertText('Very ', 1), 6)
    expect(next.openPos).toBe(11)
  })

  it('renumbers when a footnote is added or removed', () => {
    const inserted = state.tr.insert(1, schema.nodeFromJSON(note('zero')))
    expectIncrementalMatchesRebuild(inserted)
    const removed = state.tr.delete(6, 6 + state.doc.nodeAt(6)!.nodeSize)
    expectIncrementalMatchesRebuild(removed, 6)
  })
})
