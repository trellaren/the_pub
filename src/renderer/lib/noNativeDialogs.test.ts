import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/*
 * `window.prompt` is not implemented in Electron — it throws. Eight create
 * flows shipped calling it, and every one was a silent dead end: the throw
 * happened inside an async function whose rejection was discarded, so clicking
 * "New map" or pressing Ctrl+N simply did nothing. This test is the guard
 * against it coming back, because the project has no linter to carry the rule.
 *
 * `window.confirm` is deliberately allowed: Electron implements it, and four
 * working delete confirmations rely on it. Banning it here would "fix" code
 * that is not broken.
 */

const BANNED = ['window.prompt', 'window.alert'] as const

/** This file necessarily contains the patterns it forbids. */
const EXEMPT = new Set(['noNativeDialogs.test.ts'])

const ROOTS = ['src/renderer', 'src/shared']

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(full)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full
  }
}

describe('native dialogs', () => {
  it('nothing in the renderer calls window.prompt or window.alert', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..')
    const offenders: string[] = []
    let visited = 0

    for (const root of ROOTS) {
      for (const file of sourceFiles(path.join(repoRoot, root))) {
        if (EXEMPT.has(path.basename(file))) continue
        visited += 1
        const text = fs.readFileSync(file, 'utf8')
        for (const banned of BANNED) {
          if (text.includes(banned)) offenders.push(`${path.relative(repoRoot, file)} uses ${banned}`)
        }
      }
    }

    // A broken glob would make this test pass by scanning nothing, which is
    // the only way it can lie. The renderer alone is far past this floor.
    expect(visited).toBeGreaterThan(50)
    expect(
      offenders,
      'window.prompt throws in Electron — use promptForName from ui/PromptDialog instead'
    ).toEqual([])
  })
})
