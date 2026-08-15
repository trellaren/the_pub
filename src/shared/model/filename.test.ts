import { describe, it, expect } from 'vitest'
import { validateFileName, validateRelativePath, sanitizeFileName } from './filename.js'

function reason(name: string): string | null {
  const result = validateFileName(name)
  return result.ok ? null : result.reason
}

describe('validateFileName', () => {
  it('accepts the names authors actually use', () => {
    for (const name of [
      'Chapter 1.pubdoc',
      "Harlan's Return.pubdoc",
      'part-two',
      'Épilogue.pubdoc',
      '第一章.pubdoc',
      'notes (draft 3).pubdoc'
    ]) {
      expect(validateFileName(name)).toEqual({ ok: true })
    }
  })

  it('refuses characters Windows has no way to store', () => {
    // Every one of these is a perfectly legal name on Linux, which is exactly
    // why the check cannot be conditional on the host platform.
    for (const name of ['Chapter: One', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\\b']) {
      expect(validateFileName(name).ok).toBe(false)
    }
  })

  it('names the character it refused, so the message is actionable', () => {
    expect(reason('Chapter: One')).toBe('A name cannot contain :')
  })

  it('refuses a trailing dot or space', () => {
    // Windows strips these silently, so allowing them means a rename can appear
    // to succeed and produce a different name than the author typed.
    expect(validateFileName('Chapter ').ok).toBe(false)
    expect(validateFileName('Chapter.').ok).toBe(false)
    expect(validateFileName('Chapter One').ok).toBe(true)
  })

  it('refuses the reserved device names, with or without an extension', () => {
    for (const name of ['CON', 'con', 'PRN.pubdoc', 'aux', 'NUL.txt', 'COM1', 'lpt9.pubdoc']) {
      expect(validateFileName(name).ok).toBe(false)
    }
    // Only the exact stem is reserved: a real word that starts with one is fine.
    expect(validateFileName('Constance.pubdoc').ok).toBe(true)
    expect(validateFileName('auxiliary').ok).toBe(true)
    expect(validateFileName('COM10').ok).toBe(true)
  })

  it('refuses control characters, empties and directory names', () => {
    expect(validateFileName('a\u0001b').ok).toBe(false)
    expect(validateFileName('a\nb').ok).toBe(false)
    expect(validateFileName('').ok).toBe(false)
    expect(validateFileName('.').ok).toBe(false)
    expect(validateFileName('..').ok).toBe(false)
  })

  it('refuses a name too long for a filesystem to hold', () => {
    expect(validateFileName('a'.repeat(255)).ok).toBe(true)
    expect(validateFileName('a'.repeat(256)).ok).toBe(false)
  })

  it('allows a leading dot, because .thepub is one of ours', () => {
    expect(validateFileName('.thepub').ok).toBe(true)
  })
})

describe('validateRelativePath', () => {
  it('checks every segment, not just the last', () => {
    expect(validateRelativePath('parts/one/chapter.pubdoc').ok).toBe(true)
    expect(validateRelativePath('parts/CON/chapter.pubdoc').ok).toBe(false)
    expect(validateRelativePath('parts/one/a:b.pubdoc').ok).toBe(false)
  })

  it('refuses an empty path', () => {
    expect(validateRelativePath('').ok).toBe(false)
    expect(validateRelativePath('///').ok).toBe(false)
  })
})

describe('sanitizeFileName', () => {
  it('repairs a name rather than refusing it', () => {
    expect(sanitizeFileName('Chapter: One')).toBe('Chapter One')
    expect(sanitizeFileName('Book/Two')).toBe('Book Two')
    expect(sanitizeFileName('Trailing dot.')).toBe('Trailing dot')
  })

  it('produces something valid for every input it repairs', () => {
    for (const input of ['CON', '...', '   ', '<<<>>>', 'a\u0001b', '', '.']) {
      expect(validateFileName(sanitizeFileName(input)).ok).toBe(true)
    }
  })

  it('falls back when nothing usable survives', () => {
    expect(sanitizeFileName('***', 'Untitled')).toBe('Untitled')
  })
})
