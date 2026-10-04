import { describe, expect, it, vi } from 'vitest'
import type { OpenProject } from '@shared/model/manifest.js'
// The store module loads appStore, which needs the preload bridge.
vi.mock('./appStore.js', () => ({ useAppStore: { getState: () => ({}) } }))

import { survivorOf } from './projectStore.js'

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
