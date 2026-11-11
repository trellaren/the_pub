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

describe('updateManifest', () => {
  const manifest = (title: string) => ({ title }) as unknown as OpenProject['manifest']
  const open = (uri: string, title: string) =>
    useProjectStore.setState({ project: { uri, readOnly: false, manifest: manifest(title) } as OpenProject })
  const retitle = (title: string) => useProjectStore.getState().updateManifest(() => manifest(title))
  const shownTitle = () => (useProjectStore.getState().project?.manifest as unknown as { title: string }).title

  it('rolls back when the write fails', async () => {
    open('/novel', 'Old')
    invoke.mockRejectedValueOnce(new Error('disk full'))
    await retitle('New')
    expect(shownTitle()).toBe('Old')
  })

  it('ignores a reply that arrives after a newer edit', async () => {
    open('/novel', 'Old')
    let first: (value: unknown) => void = () => {}
    invoke.mockImplementationOnce(() => new Promise((resolve) => (first = resolve)))
    invoke.mockImplementationOnce(async () => manifest('Second'))
    const one = retitle('First')
    await retitle('Second')
    first(manifest('First'))
    await one
    expect(shownTitle()).toBe('Second')
  })

  it('ignores a reply for a project that is no longer open', async () => {
    open('/novel', 'Old')
    let reply: (value: unknown) => void = () => {}
    invoke.mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)))
    const pending = retitle('New')
    open('/other', 'Other')
    reply(manifest('New'))
    await pending
    expect(useProjectStore.getState().project?.uri).toBe('/other')
    expect(shownTitle()).toBe('Other')
  })
})

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
