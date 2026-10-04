import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from '@tiptap/pm/state'
import { BlockIds, mayDuplicateBlockId, dedupeLiveBlockIds } from './blockIds.js'

const schema = getSchema([StarterKit, BlockIds])

const state = EditorState.create({
  doc: schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { blockId: 'a' }, content: [{ type: 'text', text: 'alpha' }] },
      { type: 'paragraph', attrs: { blockId: 'b' }, content: [{ type: 'text', text: 'beta' }] }
    ]
  })
})

describe('block id dedupe', () => {
  it('skips the scan for typing inside a block', () => {
    expect(mayDuplicateBlockId(state.tr.insertText('x', 3))).toBe(false)
    expect(mayDuplicateBlockId(state.tr.delete(2, 4))).toBe(false)
  })

  it('notices a split that copies the id', () => {
    const split = state.tr.split(3, 1, [{ type: schema.nodes.paragraph!, attrs: { blockId: 'a' } }])
    expect(mayDuplicateBlockId(split)).toBe(true)
    const deduped = dedupeLiveBlockIds(state.apply(split))!
    const ids: string[] = []
    deduped.doc.forEach((node) => ids.push(node.attrs.blockId as string))
    expect(ids[0]).toBe('a')
    expect(new Set(ids).size).toBe(3)
  })

  it('notices a pasted block carrying an id already in use', () => {
    const pasted = schema.nodeFromJSON({ type: 'paragraph', attrs: { blockId: 'b' }, content: [{ type: 'text', text: 'copy' }] })
    expect(mayDuplicateBlockId(state.tr.insert(0, pasted))).toBe(true)
  })

  it('notices setNodeMarkup giving a block another block’s id', () => {
    expect(mayDuplicateBlockId(state.tr.setNodeMarkup(0, undefined, { blockId: 'b' }))).toBe(true)
  })
})
