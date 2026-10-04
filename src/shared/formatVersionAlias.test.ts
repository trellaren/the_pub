import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [full] : []
  })
}

describe('FORMAT_VERSION alias', () => {
  // The alias is the document counter. Another file kind importing it silently
  // re-versions itself every time the document format moves.
  it('is imported by no source file', () => {
    const root = path.resolve(__dirname, '..')
    const offenders = sourceFiles(root).filter((file) =>
      /import\s*\{[^}]*\bFORMAT_VERSION\b[^}]*\}/.test(fs.readFileSync(file, 'utf8'))
    )
    expect(offenders.map((file) => path.relative(root, file))).toEqual([])
  })
})
