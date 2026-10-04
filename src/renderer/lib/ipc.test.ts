import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { errorMessage } from './ipc.js'

describe('errorMessage', () => {
  it('strips the Electron remote-invocation prefix', () => {
    const error = new Error("Error invoking remote method 'project:open': Error: That folder is not a project")
    expect(errorMessage(error)).toBe('That folder is not a project')
  })

  it('leaves an ordinary message alone', () => {
    expect(errorMessage(new Error('Disk full'))).toBe('Disk full')
    expect(errorMessage('plain')).toBe('plain')
  })

  it('turns a zod issue list into one sentence', () => {
    const parsed = z.object({ uri: z.string() }).safeParse({ uri: 3 })
    if (parsed.success) throw new Error('expected failure')
    const error = new Error(`Error invoking remote method 'project:open': ZodError: ${parsed.error.message}`)
    const message = errorMessage(error)
    expect(message).toMatch(/^The request was not valid: .+ \(uri\)\.$/)
    expect(message).not.toContain('[')
  })

  it('does not mistake a message that merely starts with a bracket for a schema failure', () => {
    expect(errorMessage(new Error('[draft] is locked'))).toBe('[draft] is locked')
  })
})
