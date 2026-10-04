import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from '@tiptap/pm/state'
import { AiAuthored, touchesAiText, restoreMarks } from './provenance.js'

const schema = getSchema([StarterKit, AiAuthored])

const state = EditorState.create({
  doc: schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'mine ' }, { type: 'text', text: 'theirs', marks: [{ type: 'aiAuthored', attrs: { runId: 'r' } }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'elsewhere' }] }
    ]
  })
})

describe('provenance guard', () => {
  it('skips edits that never touch the assistant’s words', () => {
    expect(touchesAiText(state.tr.insertText('x', 15))).toBe(false)
    expect(touchesAiText(state.tr.insertText('x', 2))).toBe(false)
  })

  it('still restores the mark a formatting step stripped', () => {
    const stripped = state.tr.removeMark(1, 12)
    expect(touchesAiText(stripped)).toBe(true)
    const next = state.apply(stripped)
    const restored = restoreMarks([stripped], state, next)!
    expect(restored.doc.rangeHasMark(6, 12, schema.marks.aiAuthored!)).toBe(true)
  })
})
