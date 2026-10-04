import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { normalizeRelative, resolveInRoot, relativeToRoot, VfsPathError, extname, basename, dirnameRelative, realPathInside } from './paths.js'

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

describe('realPathInside', () => {
  it('follows a link that stays inside the root, and refuses one that leaves it', async () => {
    const fsp = await import('node:fs/promises')
    const os = await import('node:os')
    const nodePath = await import('node:path')
    const root = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'pub-real-'))
    const outside = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'pub-secret-'))
    try {
      await fsp.writeFile(nodePath.join(root, 'cover.png'), 'img')
      await fsp.writeFile(nodePath.join(outside, 'id_rsa'), 'secret')
      await fsp.symlink(nodePath.join(root, 'cover.png'), nodePath.join(root, 'alias.png'))
      await fsp.symlink(nodePath.join(outside, 'id_rsa'), nodePath.join(root, 'leak.png'))

      expect(await realPathInside(root, nodePath.join(root, 'alias.png'))).toBe(
        await fsp.realpath(nodePath.join(root, 'cover.png'))
      )
      expect(await realPathInside(root, nodePath.join(root, 'leak.png'))).toBeNull()
      expect(await realPathInside(root, nodePath.join(root, 'missing.png'))).toBeNull()
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
      await fsp.rm(outside, { recursive: true, force: true })
    }
  })
})
