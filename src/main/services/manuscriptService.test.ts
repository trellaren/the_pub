import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ManuscriptService, type DocumentResolver } from './manuscriptService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { childrenOf, type ManuscriptFile } from '../../shared/model/manuscript.js'
import { MANUSCRIPT_FILE } from '../../shared/constants.js'

/**
 * The binder against a real adapter and a stand-in index.
 *
 * The index is stubbed rather than real because what is under test is how the
 * manuscript behaves when resolution succeeds, fails, or has not happened yet —
 * and the third of those is a state a real index only occupies for a moment
 * after a project opens. `searchIndexService.test.ts` covers the queries
 * themselves.
 */

let root: string
let adapter: LocalAdapter
let manuscript: ManuscriptService

/** A resolver the test drives: what the index knows, and whether it is busy. */
let paths: Map<string, string>
let words: Map<string, number>
let indexing: boolean

const resolver: DocumentResolver = {
  resolvePath: (docId) => paths.get(docId) ?? null,
  wordCountsFor: (docIds) => new Map(docIds.map((id) => [id, words.get(id) ?? 0])),
  indexing: () => indexing
}

async function addChapter(name: string, parentId: string | null = null) {
  const docId = `doc-${name}`
  paths.set(docId, `${name}.pubdoc`)
  const [node] = await manuscript.addDocuments([{ docId, path: `${name}.pubdoc`, title: name }], parentId)
  return node!
}

async function onDisk(): Promise<ManuscriptFile> {
  return JSON.parse(await fs.readFile(path.join(root, MANUSCRIPT_FILE), 'utf8')) as ManuscriptFile
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-manuscript-'))
  adapter = new LocalAdapter(root)
  paths = new Map()
  words = new Map()
  indexing = false
  manuscript = new ManuscriptService(adapter, resolver)
  await manuscript.load()
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('building the book', () => {
  /* Nothing is inferred from the filesystem: a project full of chapters starts
   * with an empty binder, because filename order is only a guess at chapter
   * order and a guess written into the structure has to be noticed to be
   * corrected. */
  it('starts empty', () => {
    expect(manuscript.snapshot().nodes).toEqual([])
  })

  it('appends documents in the order they were added', async () => {
    await addChapter('one')
    await addChapter('two')
    expect(childrenOf(manuscript.snapshot().nodes, null).map((node) => node.title)).toEqual(['one', 'two'])
  })

  /* A document exported twice is a chapter printed twice and a word count that
   * double-counts it. */
  it('refuses to add the same document twice', async () => {
    await addChapter('one')
    const again = await manuscript.addDocuments([{ docId: 'doc-one', path: 'one.pubdoc', title: 'one' }])
    expect(again).toEqual([])
    expect(manuscript.snapshot().nodes).toHaveLength(1)
  })

  it('writes through to disk and reloads', async () => {
    const part = await manuscript.createPart('Part One')
    await addChapter('one', part.id)

    const reloaded = new ManuscriptService(adapter, resolver)
    const file = await reloaded.load()
    expect(file.nodes).toHaveLength(2)
    expect(file.nodes.find((node) => node.kind === 'document')!.parentId).toBe(part.id)
  })

  it('hands out copies, so a caller cannot mutate the cache', async () => {
    await addChapter('one')
    const snapshot = manuscript.snapshot()
    snapshot.nodes[0]!.title = 'Tampered'
    expect(manuscript.snapshot().nodes[0]!.title).toBe('one')
  })
})

describe('moving', () => {
  it('moves a document into a part', async () => {
    const part = await manuscript.createPart('Part One')
    const chapter = await addChapter('one')
    await manuscript.move(chapter.id, part.id, 0)
    expect((await onDisk()).nodes.find((node) => node.id === chapter.id)!.parentId).toBe(part.id)
  })

  /* Two levels in this version: a part asked to go inside another stays at the
   * root rather than producing a structure the exporter has no heading level
   * for. */
  it('keeps a part at the root even when asked to nest it', async () => {
    const outer = await manuscript.createPart('Part One')
    const inner = await manuscript.createPart('Part Two')
    await manuscript.move(inner.id, outer.id, 0)
    expect(manuscript.snapshot().nodes.find((node) => node.id === inner.id)!.parentId).toBeNull()
  })

  it('reorders within a parent, rewriting only the node that moved', async () => {
    const first = await addChapter('one')
    const second = await addChapter('two')
    const before = await onDisk()

    await manuscript.move(second.id, null, 0)

    const after = await onDisk()
    expect(childrenOf(after.nodes, null).map((node) => node.title)).toEqual(['two', 'one'])
    // The fractional-key promise: one record changed, not a renumbering.
    expect(after.nodes.find((node) => node.id === first.id)).toEqual(
      before.nodes.find((node) => node.id === first.id)
    )
  })

  it('ignores a move of something that is not there', async () => {
    await expect(manuscript.move('nonexistent', null, 0)).resolves.toBeDefined()
  })
})

describe('removing', () => {
  /* The rule that matters: a container going away must never take chapters with
   * it. Losing a chapter because a part was deleted is not a trade this code
   * gets to make. */
  it('reparents a part’s chapters rather than deleting them', async () => {
    const part = await manuscript.createPart('Part One')
    const chapter = await addChapter('one', part.id)

    await manuscript.remove(part.id)

    const nodes = manuscript.snapshot().nodes
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.id).toBe(chapter.id)
    expect(nodes[0]!.parentId).toBeNull()
  })

  it('keeps reparented chapters in their original order', async () => {
    const part = await manuscript.createPart('Part One')
    await addChapter('one', part.id)
    await addChapter('two', part.id)

    await manuscript.remove(part.id)

    expect(childrenOf(manuscript.snapshot().nodes, null).map((node) => node.title)).toEqual(['one', 'two'])
  })

  it('removes a document from the book without touching the file', async () => {
    const chapter = await addChapter('one')
    await manuscript.remove(chapter.id)
    expect(manuscript.snapshot().nodes).toEqual([])
    // The document itself is a project file and is none of the binder's business.
    expect(paths.get('doc-one')).toBe('one.pubdoc')
  })
})

describe('resolving against the index', () => {
  it('reports the current path and the word count', async () => {
    await addChapter('one')
    words.set('doc-one', 1200)
    const view = manuscript.view()
    expect(view.nodes[0]).toMatchObject({ resolvedPath: 'one.pubdoc', words: 1200, missing: false })
  })

  it('follows a document that was renamed outside the app', async () => {
    await addChapter('one')
    paths.set('doc-one', 'part-one/chapter-one.pubdoc')
    expect(manuscript.view().nodes[0]!.resolvedPath).toBe('part-one/chapter-one.pubdoc')
    expect(manuscript.view().nodes[0]!.missing).toBe(false)
  })

  it('marks a document that is genuinely gone', async () => {
    await addChapter('one')
    paths.delete('doc-one')
    expect(manuscript.view().nodes[0]).toMatchObject({ resolvedPath: null, missing: true })
  })

  /*
   * The distinction `missing` exists for. During the first index pass nothing
   * resolves, and a view that called that "missing" would tell every author
   * their whole book had vanished for the first few seconds of every session.
   */
  it('does not call anything missing while the index is still building', async () => {
    await addChapter('one')
    paths.delete('doc-one')
    indexing = true

    const view = manuscript.view()
    expect(view.resolving).toBe(true)
    expect(view.nodes[0]!.missing).toBe(false)
  })

  it('rolls a part’s word count up from its chapters', async () => {
    const part = await manuscript.createPart('Part One')
    await addChapter('one', part.id)
    await addChapter('two', part.id)
    words.set('doc-one', 1000)
    words.set('doc-two', 500)

    expect(manuscript.view().nodes.find((node) => node.id === part.id)!.words).toBe(1500)
  })

  /*
   * Reads never write.
   *
   * An author whose network drive is unplugged, or whose index has not caught
   * up, must not lose the shape of their book to a well-meaning tidy-up — so
   * this asserts on the bytes rather than on the absence of an obvious prune.
   */
  it('never writes to the file while resolving', async () => {
    await addChapter('one')
    const before = await fs.readFile(path.join(root, MANUSCRIPT_FILE))

    paths.delete('doc-one')
    manuscript.view()
    manuscript.view()

    expect(await fs.readFile(path.join(root, MANUSCRIPT_FILE))).toEqual(before)
  })

  it('keeps a missing document in the file, so it can be relinked', async () => {
    const chapter = await addChapter('one')
    paths.delete('doc-one')
    manuscript.view()

    expect((await onDisk()).nodes.find((node) => node.id === chapter.id)).toBeTruthy()
  })

  it('recovers a missing row when it is relinked', async () => {
    const chapter = await addChapter('one')
    paths.delete('doc-one')
    paths.set('doc-replacement', 'rewritten.pubdoc')

    await manuscript.relink(chapter.id, 'doc-replacement', 'rewritten.pubdoc', 'Chapter One')

    expect(manuscript.view().nodes[0]).toMatchObject({
      resolvedPath: 'rewritten.pubdoc',
      missing: false,
      title: 'Chapter One'
    })
  })

  /* The stored path is a hint for a cold index, so a write refreshes it — but
   * only a write. */
  it('refreshes a stale path hint on the next mutation', async () => {
    await addChapter('one')
    paths.set('doc-one', 'moved/one.pubdoc')

    await manuscript.createPart('Part One')

    expect((await onDisk()).nodes.find((node) => node.docId === 'doc-one')!.path).toBe('moved/one.pubdoc')
  })
})

describe('the file itself', () => {
  it('falls back to an empty binder on a corrupt file, keeping the original', async () => {
    await addChapter('one')
    await fs.writeFile(path.join(root, MANUSCRIPT_FILE), 'not json at all', 'utf8')

    const reloaded = new ManuscriptService(adapter, resolver)
    expect((await reloaded.load()).nodes).toEqual([])
    const kept = (await fs.readdir(path.join(root, '.thepub'))).filter((name) =>
      name.includes('manuscript.json.corrupt-')
    )
    expect(kept).toHaveLength(1)
  })

  /* A hand-edited file must not be able to hide a chapter behind a parent that
   * does not exist. Repaired on load, never discarded. */
  it('repairs a node whose parent is missing rather than losing it', async () => {
    await fs.mkdir(path.join(root, '.thepub'), { recursive: true })
    await fs.writeFile(
      path.join(root, MANUSCRIPT_FILE),
      JSON.stringify({
        formatVersion: 1,
        nodes: [
          { id: 'a', kind: 'document', parentId: 'nowhere', order: 0, title: 'Orphan', docId: 'doc-a', path: 'a.pubdoc' }
        ]
      }),
      'utf8'
    )

    const reloaded = new ManuscriptService(adapter, resolver)
    const file = await reloaded.load()
    expect(file.nodes).toHaveLength(1)
    expect(file.nodes[0]!.parentId).toBeNull()
  })

  it('applies concurrent writes in order', async () => {
    const chapter = await addChapter('one')
    await Promise.all([
      manuscript.rename(chapter.id, 'One'),
      manuscript.rename(chapter.id, 'Two'),
      manuscript.rename(chapter.id, 'Three')
    ])
    expect((await onDisk()).nodes[0]!.title).toBe('Three')
  })
})
