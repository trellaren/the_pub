// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/ipc.js', () => ({
  invoke: async () => null,
  attempt: async () => null,
  reportError: () => {},
  errorMessage: String,
  on: () => () => {}
}))
vi.mock('@renderer/panels/editor/createEditor.js', () => ({ createEditor: () => ({}) }))
vi.mock('@renderer/panels/editor/editorActions.js', () => ({ setSuggesting: () => {} }))

const { resetProjectScopedStores } = await import('./pendingWrites.js')
const { useEntityStore } = await import('./entityStore.js')
const { useChatStore } = await import('./chatStore.js')
const { useStatsStore } = await import('./statsStore.js')
const { useSourceStore } = await import('./sourceStore.js')

describe('resetProjectScopedStores', () => {
  it('forgets records, chats, stats and AI errors from the project being left', () => {
    useEntityStore.setState({ entities: [{ id: 'a' } as never], loaded: true })
    useSourceStore.setState({ sources: [{ id: 's' } as never] })
    useStatsStore.setState({ days: [{ day: '2026-01-01' } as never] })
    useChatStore.setState({ chats: [{ id: 'c' } as never], activeChatId: 'c', retrievalError: 'x', llmError: 'y' })
    resetProjectScopedStores()
    expect(useEntityStore.getState().entities).toEqual([])
    expect(useEntityStore.getState().loaded).toBe(false)
    expect(useSourceStore.getState().sources).toEqual([])
    expect(useStatsStore.getState().days).toEqual([])
    const chat = useChatStore.getState()
    expect([chat.chats, chat.activeChatId, chat.retrievalError, chat.llmError]).toEqual([[], null, null, null])
  })
})
