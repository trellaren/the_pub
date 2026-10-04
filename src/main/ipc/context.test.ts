import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: {}, dialog: {}, BrowserWindow: {} }))
vi.mock('../services/projectSession.js', () => ({ ProjectSession: {} }))
vi.mock('../services/aiKeyStore.js', () => ({ AiKeyStore: class {}, originOf: () => null }))
vi.mock('../ai/embeddedRuntime.js', () => ({}))

const { SessionRegistry } = await import('./context.js')
type Session = Parameters<InstanceType<typeof SessionRegistry>['set']>[1]
type FakeSession = Session & { closed: boolean }

function fakeSession(uri: string): FakeSession {
  const session = {
    uri,
    closed: false,
    close: async () => {
      session.closed = true
    }
  }
  return session as unknown as FakeSession
}

describe('SessionRegistry.replace', () => {
  it('keeps the current session open when the new one fails to open', async () => {
    const registry = new SessionRegistry()
    const current = fakeSession('/a')
    registry.set(1, current)
    await expect(registry.replace(1, '/b', () => Promise.reject(new Error('gone')))).rejects.toThrow('gone')
    expect(registry.get(1)).toBe(current)
    expect(current.closed).toBe(false)
  })

  it('closes the previous session only after the new one opened', async () => {
    const registry = new SessionRegistry()
    const current = fakeSession('/a')
    const next = fakeSession('/b')
    registry.set(1, current)
    let closedDuringOpen: boolean | null = null
    const result = await registry.replace(1, '/b', async () => {
      closedDuringOpen = current.closed
      return next
    })
    expect(closedDuringOpen).toBe(false)
    expect(result).toBe(next)
    expect(registry.get(1)).toBe(next)
    expect(current.closed).toBe(true)
  })

  it('closes first when reopening the same project', async () => {
    const registry = new SessionRegistry()
    const current = fakeSession('/a')
    registry.set(1, current)
    let closedDuringOpen: boolean | null = null
    await expect(
      registry.replace(1, '/a', async () => {
        closedDuringOpen = current.closed
        throw new Error('nope')
      })
    ).rejects.toThrow('nope')
    expect(closedDuringOpen).toBe(true)
    expect(registry.get(1)).toBeUndefined()
  })
})
