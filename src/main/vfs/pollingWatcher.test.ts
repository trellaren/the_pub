import { describe, it, expect } from 'vitest'
import { pollingWatch } from './pollingWatcher.js'
import type { VfsAdapter } from './types.js'
import type { FileChangeEvent, VfsEntry } from '../../shared/model/vfs.js'

describe('pollingWatch', () => {
  it('never starts a walk while the previous one is still running', async () => {
    let running = 0
    let overlapped = false
    let walks = 0
    const files: VfsEntry[] = [{ name: 'a', path: 'a', kind: 'file', size: 1, mtime: 1 }]
    const adapter = {
      walk: async () => {
        running += 1
        walks += 1
        if (running > 1) overlapped = true
        await new Promise((resolve) => setTimeout(resolve, 30))
        running -= 1
        return files
      }
    } as unknown as VfsAdapter

    const seen: FileChangeEvent[] = []
    const stop = pollingWatch(adapter, '', (events) => seen.push(...events), 5)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await stop()

    expect(walks).toBeGreaterThan(1)
    expect(overlapped).toBe(false)
    expect(seen).toEqual([])
  })
})
