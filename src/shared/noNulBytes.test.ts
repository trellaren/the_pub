import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const TEXT_FILE = /\.(tsx?|css|html|json|md)$/

function textFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return textFiles(full)
    return TEXT_FILE.test(entry.name) ? [full] : []
  })
}

describe('source files', () => {
  // A raw NUL makes git treat the file as binary, hiding every later change to
  // it from diffs and review. Write '\u0000' instead.
  it('contain no NUL bytes', () => {
    const root = path.resolve(__dirname, '..')
    const offenders = textFiles(root).filter((file) => fs.readFileSync(file).includes(0))
    expect(offenders.map((file) => path.relative(root, file))).toEqual([])
  })
})
