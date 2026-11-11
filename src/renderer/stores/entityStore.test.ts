import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoryEntity } from '@shared/model/entity.js'

const invoke = vi.fn()
vi.mock('@renderer/lib/ipc.js', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  attempt: async <T>(operation: Promise<T>) => operation.catch(() => null),
  on: () => () => {}
}))

const { useEntityStore } = await import('./entityStore.js')

function entity(id: string, name: string): StoryEntity {
  return { id, name, kind: 'character' } as unknown as StoryEntity
}

function serve(entities: StoryEntity[]): void {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'entities:list') return { entities, dismissed: [] }
    if (channel === 'mentions:summary') return {}
    if (channel === 'entities:delete') throw new Error('locked')
    return null
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  useEntityStore.setState(useEntityStore.getInitialState(), true)
})

describe('entityStore.load', () => {
  it('keeps an edit still waiting on its debounced write', async () => {
    serve([entity('a', 'Ann'), entity('b', 'Bob')])
    await useEntityStore.getState().load()
    useEntityStore.getState().patch('a', { name: 'Anna' })
    serve([entity('a', 'Ann'), entity('b', 'Robert'), entity('c', 'Cy')])
    await useEntityStore.getState().load()
    const names = useEntityStore.getState().entities.map((candidate) => candidate.name)
    expect(names).toEqual(['Anna', 'Robert', 'Cy'])
    vi.clearAllTimers()
  })
})

describe('entityStore.remove', () => {
  it('keeps the record when the delete fails', async () => {
    serve([entity('a', 'Ann')])
    await useEntityStore.getState().load()
    await useEntityStore.getState().remove('a')
    expect(useEntityStore.getState().entities).toHaveLength(1)
  })
})
