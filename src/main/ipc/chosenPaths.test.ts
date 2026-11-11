import path from 'node:path'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { ChosenPaths } from './chosenPaths.js'

const picked = path.join(os.tmpdir(), 'novel.pubdb')

describe('ChosenPaths', () => {
  it('knows only what was recorded', () => {
    const chosen = new ChosenPaths(false)
    expect(chosen.has(picked)).toBe(false)
    chosen.record(picked)
    expect(chosen.has(picked)).toBe(true)
    expect(chosen.has(path.join(os.homedir(), '.ssh', 'id_rsa'))).toBe(false)
  })

  it('refuses an unpicked local URI and lets a remote one through', () => {
    const chosen = new ChosenPaths(false)
    expect(() => chosen.requireLocalChosen(os.tmpdir(), 'A folder')).toThrow('file dialog')
    expect(() => chosen.requireLocalChosen('sftp://01ABC/books', 'A folder')).not.toThrow()
    chosen.record(os.tmpdir())
    expect(() => chosen.requireLocalChosen(os.tmpdir(), 'A folder')).not.toThrow()
  })

  it('trusts everything only when the harness says so', () => {
    expect(new ChosenPaths(true).has('/anything')).toBe(true)
  })
})
