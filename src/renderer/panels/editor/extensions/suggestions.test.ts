import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, Plugin, TextSelection } from '@tiptap/pm/state'
import { Insertion, Deletion, suggestionModeKey, planRewrite, applyPlan, trackPending } from './suggestions.js'

const schema = getSchema([StarterKit, Insertion, Deletion])

function stateWith(text: string, authorId = 'me'): EditorState {
  const modePlugin = new Plugin({
    key: suggestionModeKey,
    state: { init: () => ({ enabled: true, authorId }), apply: (_tr, value) => value }
  })
  return EditorState.create({
    doc: schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }),
    plugins: [modePlugin]
  })
}

function runs(state: EditorState): { text: string; marks: string[] }[] {
  const found: { text: string; marks: string[] }[] = []
  state.doc.descendants((node) => {
    if (node.isText) found.push({ text: node.text ?? '', marks: node.marks.map((mark) => mark.type.name).sort() })
  })
  return found
}

describe('suggesting mode rewrite', () => {
  it('keeps the inserted text when typing over a selection', () => {
    const state = stateWith('hello world')
    const typed = state.tr.insertText('there', 7, 12)
    const plan = planRewrite(typed, state)!
    expect(plan).not.toBeNull()
    const next = state.apply(applyPlan(plan, state)!)
    expect(runs(next)).toEqual([
      { text: 'hello ', marks: [] },
      { text: 'world', marks: ['deletion'] },
      { text: 'there', marks: ['insertion'] }
    ])
    expect(next.selection.from).toBe(17)
  })

  it('keeps every replacement of a multi-step replace-all', () => {
    const state = stateWith('cat and cat')
    const tr = state.tr.insertText('dog', 9, 12).insertText('dog', 1, 4)
    const next = state.apply(applyPlan(planRewrite(tr, state)!, state)!)
    expect(next.doc.textContent).toBe('catdog and catdog')
    expect(runs(next).filter((run) => run.marks.includes('insertion')).map((run) => run.text)).toEqual(['dog', 'dog'])
  })

  it('really removes the author’s own pending insertion it replaces', () => {
    const base = stateWith('ab')
    const own = base.apply(base.tr.addMark(1, 3, schema.marks.insertion!.create({ authorId: 'me' })))
    const next = own.apply(applyPlan(planRewrite(own.tr.insertText('x', 1, 3), own)!, own)!)
    expect(runs(next)).toEqual([{ text: 'x', marks: ['insertion'] }])
  })

  it('lets plain insertions through untouched', () => {
    const state = stateWith('ab')
    expect(planRewrite(state.tr.insertText('x', 2), state)).toBeNull()
  })

  it('replays against the current document when another edit landed first', () => {
    const state = stateWith('hello world')
    const plan = planRewrite(state.tr.insertText('there', 7, 12), state)!
    const between = state.tr.insertText('Oh, ', 1)
    const later = state.apply(between)
    trackPending([plan], between, later)
    expect(plan.doc).toBe(later.doc)
    const next = later.apply(applyPlan(plan, later)!)
    expect(runs(next)).toEqual([
      { text: 'Oh, hello ', marks: [] },
      { text: 'world', marks: ['deletion'] },
      { text: 'there', marks: ['insertion'] }
    ])
  })

  it('selection deletion alone strikes through without moving text', () => {
    const state = stateWith('hello')
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 1, 3)).deleteSelection()
    const next = state.apply(applyPlan(planRewrite(tr, state)!, state)!)
    expect(runs(next)).toEqual([
      { text: 'he', marks: ['deletion'] },
      { text: 'llo', marks: [] }
    ])
  })
})
