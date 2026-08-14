import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { normalizeRelative, resolveInRoot, relativeToRoot, VfsPathError, extname, basename, dirnameRelative } from './paths.js'

const root = path.resolve('/tmp/pub-project')

describe('normalizeRelative', () => {
  it('strips leading slashes and redundant segments', () => {
    expect(normalizeRelative('/manuscript//./chapter-01.pubdoc')).toBe('manuscript/chapter-01.pubdoc')
  })

  it('normalizes Windows separators', () => {
    expect(normalizeRelative('manuscript\\part-one\\ch1.pubdoc')).toBe('manuscript/part-one/ch1.pubdoc')
  })

  it('rejects parent traversal rather than clamping it', () => {
    expect(() => normalizeRelative('../../etc/passwd')).toThrow(VfsPathError)
    expect(() => normalizeRelative('manuscript/../../secrets')).toThrow(VfsPathError)
  })

  it('rejects Windows absolute paths', () => {
    expect(() => normalizeRelative('C:/Windows/System32')).toThrow(VfsPathError)
  })
})

describe('resolveInRoot', () => {
  it('resolves a relative path inside the project', () => {
    expect(resolveInRoot(root, 'notes/ideas.md')).toBe(path.join(root, 'notes/ideas.md'))
  })

  it('resolves the root itself for an empty path', () => {
    expect(resolveInRoot(root, '')).toBe(root)
  })

  it('refuses to escape the project root', () => {
    expect(() => resolveInRoot(root, '../other-project/file')).toThrow(VfsPathError)
  })

  it('does not treat a sibling directory with a shared prefix as inside the root', () => {
    // `/tmp/pub-project-backup` starts with the root string but is not in it.
    expect(() => resolveInRoot(root, '../pub-project-backup/x')).toThrow(VfsPathError)
  })
})

describe('relativeToRoot', () => {
  it('produces POSIX project-relative paths', () => {
    expect(relativeToRoot(root, path.join(root, 'a', 'b.pubdoc'))).toBe('a/b.pubdoc')
  })
})

describe('path helpers', () => {
  it('splits names, directories and extensions', () => {
    expect(basename('a/b/c.pubdoc')).toBe('c.pubdoc')
    expect(dirnameRelative('a/b/c.pubdoc')).toBe('a/b')
    expect(dirnameRelative('c.pubdoc')).toBe('')
    expect(extname('a/b/c.pubdoc')).toBe('.pubdoc')
  })

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(extname('.thepub')).toBe('')
  })
})
