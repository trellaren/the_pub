import { describe, it, expect } from 'vitest'
import type { VfsEntry } from '@shared/model/vfs.js'
import { flatten, parentFor, findEntry, ancestorsOf } from './tree.js'

const file = (path: string): VfsEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'file'
})
const dir = (path: string): VfsEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'dir'
})

describe('parentFor', () => {
  it('creates inside a selected folder', () => {
    expect(parentFor('part-one', 'dir')).toBe('part-one')
  })

  /*
   * The old implementation asked whether the folder's listing was loaded, so a
   * selected-but-never-expanded folder sent the new file to its parent instead
   * of inside itself.
   */
  it('does so whether or not the folder was ever expanded', () => {
    expect(parentFor('never/expanded', 'dir')).toBe('never/expanded')
  })

  it('creates beside a selected file', () => {
    expect(parentFor('part-one/chapter.pubdoc', 'file')).toBe('part-one')
    expect(parentFor('rooted.pubdoc', 'file')).toBe('')
  })
})

describe('ancestorsOf', () => {
  it('lists every directory above a path, root first', () => {
    expect(ancestorsOf('a/b/c.pubdoc')).toEqual(['', 'a', 'a/b'])
  })

  it('a root-level path has only the root above it', () => {
    expect(ancestorsOf('chapter.pubdoc')).toEqual([''])
  })
})

describe('findEntry', () => {
  const children = {
    '': [dir('a'), file('one.pubdoc')],
    a: [file('a/two.pubdoc')]
  }

  it('finds an entry by path in its parent listing', () => {
    expect(findEntry('a/two.pubdoc', children)?.kind).toBe('file')
    expect(findEntry('a', children)?.kind).toBe('dir')
  })

  it('answers null for the unknown', () => {
    expect(findEntry('a/three.pubdoc', children)).toBeNull()
    expect(findEntry('unloaded/x', children)).toBeNull()
  })
})

describe('flatten', () => {
  it('recurses only into expanded directories', () => {
    const children = {
      '': [dir('a'), file('one.pubdoc')],
      a: [dir('a/b'), file('a/two.pubdoc')],
      'a/b': [file('a/b/three.pubdoc')]
    }
    const rows = flatten('', children, new Set(['', 'a']), 0)
    expect(rows.map((row) => `${row.depth}:${row.path}`)).toEqual([
      '0:a',
      '1:a/b',
      '1:a/two.pubdoc',
      '0:one.pubdoc'
    ])
  })
})
