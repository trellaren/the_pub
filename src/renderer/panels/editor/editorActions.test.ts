// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { Editor, getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { FindHighlight } from './extensions/findHighlight.js'
import { Insertion, Deletion } from './extensions/suggestions.js'
import { removeAnchor, replaceCurrent, replaceDocumentTransaction, setFind } from './editorActions.js'
import { Anchors } from './extensions/anchors.js'
import type { PmDoc } from '@shared/model/document.js'

const schema = getSchema([StarterKit, Insertion, Deletion])

function paragraphs(...texts: string[]): PmDoc {
  return {
    type: 'doc',
    content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
  } as PmDoc
}

describe('replaceDocumentTransaction', () => {
  it('replaces only the span that changed', () => {
    const state = EditorState.create({ doc: schema.nodeFromJSON(paragraphs('one', 'two words', 'three')) })
    const transaction = replaceDocumentTransaction(state, paragraphs('one', 'two', 'three'))
    expect(transaction.doc.toJSON()).toEqual(paragraphs('one', 'two', 'three'))
    expect(transaction.steps).toHaveLength(1)
    const step = transaction.steps[0] as ReplaceStep
    expect(step.from).toBeGreaterThanOrEqual(6)
    expect(step.to).toBeLessThanOrEqual(16)
  })

  it('maps the selection through the change rather than clamping it', () => {
    const state = EditorState.create({ doc: schema.nodeFromJSON(paragraphs('one extra', 'three')) })
    const atThree = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 13)))
    const transaction = replaceDocumentTransaction(atThree, paragraphs('one', 'three'))
    expect(transaction.doc.textBetween(transaction.selection.from, transaction.selection.from + 2)).toBe('hr')
  })

  it('is a no-op step-wise when nothing differs', () => {
    const state = EditorState.create({ doc: schema.nodeFromJSON(paragraphs('same')) })
    expect(replaceDocumentTransaction(state, paragraphs('same')).steps).toHaveLength(0)
  })
})

describe('replaceCurrent', () => {
  let editor: Editor | null = null
  afterEach(() => editor?.destroy())

  it('inserts the replacement as plain text, not parsed HTML', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, FindHighlight],
      content: paragraphs('find me')
    })
    setFind(editor, { term: 'me', matchCase: false, wholeWord: false })
    replaceCurrent(editor, '<b>you</b> & co')
    expect(editor.state.doc.textContent).toBe('find <b>you</b> & co')
  })

  it('replaces consecutive matches one after another without skipping', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, FindHighlight],
      content: paragraphs('a a a a')
    })
    setFind(editor, { term: 'a', matchCase: false, wholeWord: false })
    replaceCurrent(editor, 'b')
    replaceCurrent(editor, 'b')
    expect(editor.state.doc.textContent).toBe('b b a a')
  })

  it('moves past a replacement that itself matches', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, FindHighlight],
      content: paragraphs('cat cat')
    })
    setFind(editor, { term: 'cat', matchCase: false, wholeWord: false })
    replaceCurrent(editor, 'cats')
    replaceCurrent(editor, 'cats')
    expect(editor.state.doc.textContent).toBe('cats cats')
  })
})

describe('removeAnchor', () => {
  let editor: Editor | null = null
  afterEach(() => editor?.destroy())

  it('takes off only the named anchor, leaving the text and other anchors', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, Anchors],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'kept', marks: [{ type: 'anchor', attrs: { anchorId: 'keep' } }] },
              { type: 'text', text: ' gone', marks: [{ type: 'anchor', attrs: { anchorId: 'drop' } }] }
            ]
          }
        ]
      }
    })
    removeAnchor(editor, 'drop')
    const ids: string[] = []
    editor.state.doc.descendants((node) => {
      for (const mark of node.marks) ids.push(String(mark.attrs.anchorId))
    })
    expect(ids).toEqual(['keep'])
    expect(editor.state.doc.textContent).toBe('kept gone')
  })
})
