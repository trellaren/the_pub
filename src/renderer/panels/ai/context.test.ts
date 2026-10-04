import { describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '@shared/model/ai.js'
import { basename, documentPathOf, hasEditorSelection } from './context.js'

// The real store reaches for the preload bridge on import, which a unit test has no window for.
vi.mock('@renderer/stores/documentStore.js', () => ({
  useDocumentStore: { getState: () => ({ activeDocId: null }) },
  getEditor: (docId: string) =>
    ({
      collapsed: { state: { selection: { from: 4, to: 4 } } },
      ranged: { state: { selection: { from: 4, to: 9 } } }
    })[docId]
}))

const call = (name: string, args: string): ToolCall => ({ id: '1', name, args, result: '', ok: true }) as ToolCall

describe('documentPathOf', () => {
  it('returns the path a document tool was called with', () => {
    expect(documentPathOf(call('suggest_edit', '{"path":"ch1.qdoc"}'))).toBe('ch1.qdoc')
  })
  it('ignores tools that do not touch a document', () => {
    expect(documentPathOf(call('search', '{"path":"ch1.qdoc"}'))).toBeNull()
  })
  it('tolerates missing, empty or malformed arguments', () => {
    expect(documentPathOf(call('comment', ''))).toBeNull()
    expect(documentPathOf(call('comment', '{"path":""}'))).toBeNull()
    expect(documentPathOf(call('comment', '{"path":3}'))).toBeNull()
    expect(documentPathOf(call('comment', '{not json'))).toBeNull()
  })
})

describe('basename', () => {
  it('splits on either separator', () => {
    expect(basename('/models/a.gguf')).toBe('a.gguf')
    expect(basename('C:\\models\\b.gguf')).toBe('b.gguf')
    expect(basename('plain.gguf')).toBe('plain.gguf')
  })
})

describe('hasEditorSelection', () => {
  it('is true only for an open editor with a non-empty selection', () => {
    expect(hasEditorSelection('ranged')).toBe(true)
    expect(hasEditorSelection('collapsed')).toBe(false)
    expect(hasEditorSelection('missing')).toBe(false)
    expect(hasEditorSelection(null)).toBe(false)
  })
})
