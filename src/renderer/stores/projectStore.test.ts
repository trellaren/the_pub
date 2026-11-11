import { describe, expect, it, vi } from 'vitest'
import type { OpenProject } from '@shared/model/manifest.js'
// The store module loads appStore, which needs the preload bridge.
vi.mock('./appStore.js', () => ({ useAppStore: { getState: () => ({}) } }))

const invoke = vi.fn()
vi.mock('@renderer/lib/ipc.js', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  attempt: async <T>(operation: Promise<T>) => operation.catch(() => null)
}))

import { survivorOf, useProjectStore, onProjectLost } from './projectStore.js'

describe('open', () => {
  it('resets to no project when reopening the current project fails', async () => {
    const lost = vi.fn(async () => {})
    onProjectLost(lost)
    useProjectStore.setState({ project: { uri: '/novel' } as OpenProject })
    invoke.mockRejectedValueOnce(new Error('gone'))
    await useProjectStore.getState().open('/novel')
    expect(useProjectStore.getState().project).toBeNull()
    expect(lost).toHaveBeenCalledOnce()
  })

  it('keeps the current project when a different one fails to open', async () => {
    const lost = vi.fn(async () => {})
    onProjectLost(lost)
    useProjectStore.setState({ project: { uri: '/novel' } as OpenProject })
    invoke.mockRejectedValueOnce(new Error('nope'))
    await useProjectStore.getState().open('/other')
    expect(useProjectStore.getState().project?.uri).toBe('/novel')
    expect(lost).not.toHaveBeenCalled()
  })
})

const project = { uri: '/novel' } as OpenProject

describe('survivorOf', () => {
  it('keeps the current project when a different one failed to open', () => {
    expect(survivorOf(project, '/other')).toBe(project)
  })
  it('drops the current project when reopening it failed, since main closed it first', () => {
    expect(survivorOf(project, '/novel')).toBeNull()
  })
  it('stays empty with nothing open', () => {
    expect(survivorOf(null, '/novel')).toBeNull()
  })
})
