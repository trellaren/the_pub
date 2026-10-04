import { describe, it, expect } from 'vitest'
import { PresenceService } from './presenceService.js'
import type { VfsAdapter } from '../vfs/types.js'
import type { AuthorProfile } from '../../shared/model/author.js'

describe('PresenceService', () => {
  it('waits for a beat in flight before deleting, so it cannot land after leaving', async () => {
    const files = new Map<string, Buffer>()
    let finishWrite: () => void = () => {}
    const adapter = {
      mkdir: async () => {},
      writeFileAtomic: (path: string, data: Buffer) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            files.set(path, data)
            resolve()
          }
        }),
      delete: async (path: string) => {
        files.delete(path)
      }
    } as unknown as VfsAdapter
    const me = { id: 'author-1', name: 'Ada', color: '#123456' } as AuthorProfile
    const presence = new PresenceService(adapter, () => me)

    void presence.enter('doc-1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const left = presence.leave()
    finishWrite()
    await left

    expect(files.size).toBe(0)
  })
})
