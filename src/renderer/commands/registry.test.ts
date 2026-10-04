import { afterEach, describe, expect, it } from 'vitest'
import { isRegistered, listCommands, registerCommand, runCommand } from './registry.js'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()))

function register(...args: Parameters<typeof registerCommand>): void {
  cleanup.push(registerCommand(...args))
}

describe('command registry', () => {
  it('neither runs nor lists a command whose every registration is disabled', () => {
    let ran = false
    register({ id: 'test.disabled', title: 'Disabled', isEnabled: () => false, run: () => (ran = true) })
    expect(runCommand('test.disabled')).toBe(false)
    expect(ran).toBe(false)
    expect(listCommands().map((command) => command.id)).not.toContain('test.disabled')
    expect(isRegistered('test.disabled')).toBe(true)
  })

  it('runs the enabled registration with the highest priority', () => {
    const ran: string[] = []
    register({ id: 'test.shared', title: 'A', run: () => ran.push('low') })
    register({ id: 'test.shared', title: 'B', priority: 1, run: () => ran.push('high') })
    register({ id: 'test.shared', title: 'C', priority: 2, isEnabled: () => false, run: () => ran.push('off') })
    expect(runCommand('test.shared')).toBe(true)
    expect(ran).toEqual(['high'])
  })

  it('knows an id nothing registered', () => {
    expect(runCommand('test.missing')).toBe(false)
    expect(isRegistered('test.missing')).toBe(false)
  })
})
