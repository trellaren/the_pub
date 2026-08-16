import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SearchIndexService, toMatchExpression, buildSnippet, formMatchExpression } from './searchIndexService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import type { PubDocument, PmDoc } from '../../shared/model/document.js'
import { storyEntitySchema, type EntityFile, type StoryEntity } from '../../shared/model/entity.js'

let root: string
let adapter: LocalAdapter
let index: SearchIndexService
let roster: EntityFile

function entity(patch: { id: string; name: string } & Partial<StoryEntity>): StoryEntity {
  return storyEntitySchema.parse({
    kind: 'character',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...patch
  })
}

function document(docId: string, title: string, paragraphs: string[]): PubDocument {
  return {
    formatVersion: 1,
    docId,
    title,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    wordCount: 0,
    content: {
      type: 'doc',
      content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
    }
  }
}

/** A document whose content is given as ProseMirror JSON, for mention tests. */
function richDocument(docId: string, title: string, content: PmDoc): PubDocument {
  return {
    formatVersion: 1,
    docId,
    title,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    wordCount: 0,
    content
  }
}

async function write(docPath: string, doc: PubDocument): Promise<void> {
  await adapter.writeFile(docPath, Buffer.from(JSON.stringify(doc), 'utf8'))
}

function dbPath(): string {
  return path.join(root, '.thepub', 'index.db')
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-index-'))
  adapter = new LocalAdapter(root)
  roster = { formatVersion: 1, entities: [], dismissed: [] }
  index = new SearchIndexService(adapter, dbPath(), () => {}, () => roster)
})

afterEach(async () => {
  index.close()
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

const query = { limit: 50, matchCase: false, wholeWord: false } as const

describe('toMatchExpression', () => {
  it('prefix-matches the final term so results narrow while typing', () => {
    expect(toMatchExpression('storm')).toBe('"storm"*')
    expect(toMatchExpression('the coming storm')).toBe('"the" AND "coming" AND "storm"*')
  })

  it('quotes FTS operators so they are searched for literally', () => {
    expect(toMatchExpression('OR NEAR')).toBe('"OR" AND "NEAR"*')
  })

  it('returns null when there is nothing to search for', () => {
    expect(toMatchExpression('   ')).toBeNull()
    expect(toMatchExpression('!!!')).toBeNull()
  })
})

describe('buildSnippet', () => {
  it('trims a long block around the first match and shifts the ranges', () => {
    const text = `${'a'.repeat(200)}needle${'b'.repeat(200)}`
    const { snippet, ranges } = buildSnippet(text, [{ start: 200, end: 206 }])
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.slice(ranges[0]!.start, ranges[0]!.end)).toBe('needle')
  })
})

describe('SearchIndexService', () => {
  it('finds text and reports the block it is in', async () => {
    await write('ch1.pubdoc', document('doc-1', 'Chapter One', ['A quiet morning.', 'Then the storm broke.']))
    await index.syncAll()

    const hits = index.query({ ...query, text: 'storm' })
    const content = hits.find((hit) => hit.kind === 'content')
    expect(content?.docId).toBe('doc-1')
    expect(content?.blockIndex).toBe(1)
    expect(content?.snippet).toContain('storm')
  })

  it('matches filenames as well as content', async () => {
    await write('storm-notes.pubdoc', document('doc-2', 'Notes', ['Nothing relevant here.']))
    await index.syncAll()
    const hits = index.query({ ...query, text: 'storm' })
    expect(hits.some((hit) => hit.kind === 'filename')).toBe(true)
  })

  it('honours whole-word search', async () => {
    await write('a.pubdoc', document('doc-3', 'A', ['The stormy sea.']))
    await index.syncAll()
    expect(index.query({ ...query, text: 'storm' }).some((hit) => hit.kind === 'content')).toBe(true)
    expect(
      index.query({ ...query, text: 'storm', wholeWord: true }).some((hit) => hit.kind === 'content')
    ).toBe(false)
  })

  it('honours case-sensitive search', async () => {
    await write('a.pubdoc', document('doc-4', 'A', ['Harlan went north.']))
    await index.syncAll()
    expect(index.query({ ...query, text: 'harlan' }).some((hit) => hit.kind === 'content')).toBe(true)
    expect(
      index.query({ ...query, text: 'harlan', matchCase: true }).some((hit) => hit.kind === 'content')
    ).toBe(false)
  })

  it('reflects edits on re-index without duplicating hits', async () => {
    await write('a.pubdoc', document('doc-5', 'A', ['The storm broke.']))
    await index.indexDocument('a.pubdoc')
    await write('a.pubdoc', document('doc-5', 'A', ['The calm returned.']))
    await index.indexDocument('a.pubdoc')

    expect(index.query({ ...query, text: 'storm' }).filter((hit) => hit.kind === 'content')).toHaveLength(0)
    expect(index.query({ ...query, text: 'calm' }).filter((hit) => hit.kind === 'content')).toHaveLength(1)
  })

  it('drops documents that are deleted from the project', async () => {
    await write('a.pubdoc', document('doc-6', 'A', ['Ephemeral.']))
    await index.syncAll()
    await adapter.delete('a.pubdoc')
    await index.syncAll()
    expect(index.query({ ...query, text: 'Ephemeral' })).toHaveLength(0)
  })

  it('resolves a document id to its current path after a move', async () => {
    await write('a.pubdoc', document('doc-7', 'A', ['Somewhere.']))
    await index.syncAll()
    expect(index.resolvePath('doc-7')).toBe('a.pubdoc')

    await adapter.rename('a.pubdoc', 'chapters/a.pubdoc')
    await index.syncAll()
    expect(index.resolvePath('doc-7')).toBe('chapters/a.pubdoc')
  })

  it('leaves the index intact when a document is unreadable mid-write', async () => {
    await write('a.pubdoc', document('doc-8', 'A', ['Real content.']))
    await index.syncAll()
    await adapter.writeFile('a.pubdoc', Buffer.from('{ this is not json'))
    await index.indexDocument('a.pubdoc')
    // The previous entry survives rather than the document vanishing from search.
    expect(index.query({ ...query, text: 'Real' }).some((hit) => hit.kind === 'content')).toBe(true)
  })

  it('ignores its own cache directory when scanning', async () => {
    await write('a.pubdoc', document('doc-9', 'A', ['Indexed.']))
    await write('.thepub/snapshots/doc-9/old.pubdoc', document('doc-9', 'A', ['Indexed.']))
    await index.syncAll()
    const hits = index.query({ ...query, text: 'Indexed' }).filter((hit) => hit.kind === 'content')
    expect(hits).toHaveLength(1)
  })
})

describe('formMatchExpression', () => {
  it('ANDs a form’s tokens without a prefix wildcard', () => {
    expect(formMatchExpression('Blue Ridge')).toBe('"Blue" AND "Ridge"')
  })

  it('drops punctuation, so the scanner rather than FTS decides', () => {
    expect(formMatchExpression("Harlan's")).toBe('"Harlan" AND "s"')
    expect(formMatchExpression('!!!')).toBeNull()
  })
})

describe('mentions', () => {
  const mentionMark = (entityId: string) => [{ type: 'mention', attrs: { entityId } }]
  const harlan = entity({ id: 'e1', name: 'Harlan' })
  const mentionQuery = { limit: 100 } as const

  it('records a bare name as a suggestion and a mark as confirmed', async () => {
    roster.entities = [harlan]
    await write(
      'ch1.pubdoc',
      richDocument('doc-m1', 'Chapter One', {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Harlan went north.' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Nobody followed ' },
              { type: 'text', marks: mentionMark('e1'), text: 'Harlan' },
              { type: 'text', text: '.' }
            ]
          }
        ]
      })
    )
    await index.syncAll()

    const hits = index.mentionsForEntity({ ...mentionQuery, entityId: 'e1' })
    expect(hits).toHaveLength(2)
    expect(hits.filter((hit) => hit.confirmed)).toHaveLength(1)
    // Confirmed rows come first, and each snippet highlights the mention.
    expect(hits[0]!.confirmed).toBe(true)
    expect(hits[0]!.blockIndex).toBe(1)
    for (const hit of hits) {
      expect(hit.snippet.slice(hit.ranges[0]!.start, hit.ranges[0]!.end)).toBe('Harlan')
      expect(hit.path).toBe('ch1.pubdoc')
      expect(hit.title).toBe('Chapter One')
    }
  })

  it('suppresses the suggestion at a confirmed mention but not a second occurrence', async () => {
    roster.entities = [harlan]
    await write(
      'ch1.pubdoc',
      richDocument('doc-m2', 'Chapter One', {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', marks: mentionMark('e1'), text: 'Harlan' },
              { type: 'text', text: " told Harlan's brother." }
            ]
          }
        ]
      })
    )
    await index.syncAll()

    const hits = index.mentionsForEntity({ ...mentionQuery, entityId: 'e1' })
    expect(hits).toHaveLength(2)
    expect(hits.map((hit) => hit.confirmed)).toEqual([true, false])
    expect(hits[1]!.ordinal).toBe(1)
  })

  it('filters by confirmation state', async () => {
    roster.entities = [harlan]
    await write('a.pubdoc', document('doc-m3', 'A', ['Harlan went north.']))
    await index.syncAll()
    expect(index.mentionsForEntity({ ...mentionQuery, entityId: 'e1', confirmed: true })).toHaveLength(0)
    expect(index.mentionsForEntity({ ...mentionQuery, entityId: 'e1', confirmed: false })).toHaveLength(1)
  })

  it('counts mentions per record for the list badges', async () => {
    roster.entities = [harlan, entity({ id: 'e2', name: 'Mira' })]
    await write('a.pubdoc', document('doc-m4', 'A', ['Harlan and Mira.']))
    await write('b.pubdoc', document('doc-m5', 'B', ['Harlan alone.']))
    await index.syncAll()

    const summary = index.mentionSummary()
    expect(summary['e1']).toEqual({ confirmed: 0, unconfirmed: 2, documents: 2 })
    expect(summary['e2']).toEqual({ confirmed: 0, unconfirmed: 1, documents: 1 })
  })

  it('re-points suggestions on a rename without reading any file', async () => {
    roster.entities = [harlan]
    await write('a.pubdoc', document('doc-m6', 'A', ['Harlan met Mira at dusk.']))
    await index.syncAll()
    expect(index.mentionsForEntity({ ...mentionQuery, entityId: 'e1' })).toHaveLength(1)

    // Delete the document from disk: a rescan that touched the filesystem would
    // now find nothing, so this is what proves the rescan is file-free.
    await adapter.delete('a.pubdoc')

    roster.entities = [entity({ id: 'e1', name: 'Mira' })]
    index.invalidateRoster()
    index.rescanSuggestions()

    const hits = index.mentionsForEntity({ ...mentionQuery, entityId: 'e1' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.surface).toBe('Mira')
  })

  it('leaves confirmed mentions untouched when a record is renamed', async () => {
    roster.entities = [harlan]
    await write(
      'a.pubdoc',
      richDocument('doc-m7', 'A', {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', marks: mentionMark('e1'), text: 'Harlan' }]
          }
        ]
      })
    )
    await index.syncAll()

    roster.entities = [entity({ id: 'e1', name: 'Reed' })]
    index.invalidateRoster()
    index.rescanSuggestions()

    // Marks carry the record's id, not its spelling, so a rename cannot break them.
    const hits = index.mentionsForEntity({ ...mentionQuery, entityId: 'e1' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ confirmed: true, surface: 'Harlan' })
  })

  it('honours a dismissal', async () => {
    roster.entities = [harlan]
    await write('a.pubdoc', document('doc-m8', 'A', ['Harlan went north.']))
    await index.syncAll()

    roster.dismissed = [{ entityId: 'e1', docId: 'doc-m8', surface: 'Harlan' }]
    index.invalidateRoster()
    index.rescanSuggestions()
    expect(index.mentionsForEntity({ ...mentionQuery, entityId: 'e1' })).toHaveLength(0)
  })

  it('clears a deleted document’s mentions and rebuilds them on a forced sync', async () => {
    roster.entities = [harlan]
    await write('a.pubdoc', document('doc-m9', 'A', ['Harlan went north.']))
    await index.syncAll()
    expect(index.mentionsForEntity({ ...mentionQuery, entityId: 'e1' })).toHaveLength(1)

    index.removeDoc('doc-m9')
    expect(index.mentionsForEntity({ ...mentionQuery, entityId: 'e1' })).toHaveLength(0)

    await index.syncAll(true)
    expect(index.mentionsForEntity({ ...mentionQuery, entityId: 'e1' })).toHaveLength(1)
  })

  it('does not duplicate mentions when a document is indexed twice', async () => {
    roster.entities = [harlan]
    await write('a.pubdoc', document('doc-m10', 'A', ['Harlan went north.']))
    await index.indexDocument('a.pubdoc')
    await index.indexDocument('a.pubdoc')
    expect(index.mentionsForEntity({ ...mentionQuery, entityId: 'e1' })).toHaveLength(1)
  })

  it('rebuilds a database written by an older schema', async () => {
    // The regression test for a silent failure: syncAll diffs mtimes, so a new
    // table added without dropping `files` would stay empty forever on any
    // project that had already been indexed.
    roster.entities = [harlan]
    await write('a.pubdoc', document('doc-m11', 'A', ['Harlan went north.']))
    await index.syncAll()
    index.close()

    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(dbPath())
    raw.exec('DROP TABLE mentions')
    raw.exec('PRAGMA user_version = 1')
    raw.close()

    index = new SearchIndexService(adapter, dbPath(), () => {}, () => roster)
    // Dropping `files` is what forces the mtime diff to re-index everything.
    expect(index.resolvePath('doc-m11')).toBeNull()
    await index.syncAll()
    expect(index.resolvePath('doc-m11')).toBe('a.pubdoc')
    expect(index.mentionsForEntity({ ...mentionQuery, entityId: 'e1' })).toHaveLength(1)
  })
})

describe('embeddings', () => {
  /** A vector pointing along one axis, so similarity is easy to reason about. */
  function axis(index: number, size = 4): Float32Array {
    const vector = new Float32Array(size)
    vector[index] = 1
    return vector
  }

  it('lists every block as pending until it has a vector, then none', async () => {
    await write('a.pubdoc', document('doc-e1', 'A', ['The harbour was quiet.', 'Rain came late.']))
    await index.syncAll()

    expect(index.embeddingCoverage()).toEqual({ embedded: 0, total: 2 })
    const pending = index.pendingEmbeddings(10)
    expect(pending).toHaveLength(2)

    for (const [position, block] of pending.entries()) {
      index.writeEmbedding(block.docId, block.blockIndex, block.text, axis(position))
    }
    expect(index.pendingEmbeddings(10)).toHaveLength(0)
    expect(index.embeddingCoverage()).toEqual({ embedded: 2, total: 2 })
  })

  it('keeps the vector of a paragraph an edit did not touch', async () => {
    await write('a.pubdoc', document('doc-e2', 'A', ['Unchanged line.', 'Original line.']))
    await index.syncAll()
    for (const block of index.pendingEmbeddings(10)) {
      index.writeEmbedding(block.docId, block.blockIndex, block.text, axis(block.blockIndex))
    }

    await write('a.pubdoc', document('doc-e2', 'A', ['Unchanged line.', 'Rewritten line.']))
    await index.indexDocument('a.pubdoc')

    // This is the whole of what makes embedding incremental: a one-word fix in
    // a chapter must not re-embed the book.
    const pending = index.pendingEmbeddings(10)
    expect(pending.map((block) => block.text)).toEqual(['Rewritten line.'])
  })

  it('drops the vectors of paragraphs an edit removed', async () => {
    await write('a.pubdoc', document('doc-e3', 'A', ['One.', 'Two.', 'Three.']))
    await index.syncAll()
    for (const block of index.pendingEmbeddings(10)) {
      index.writeEmbedding(block.docId, block.blockIndex, block.text, axis(block.blockIndex))
    }

    await write('a.pubdoc', document('doc-e3', 'A', ['One.']))
    await index.indexDocument('a.pubdoc')

    // Otherwise the chapter keeps answering searches with prose it no longer
    // contains.
    expect(index.embeddingCoverage()).toEqual({ embedded: 1, total: 1 })
  })

  it('ranks passages by cosine and resolves them to a document and block', async () => {
    await write('a.pubdoc', document('doc-e4', 'Harbour', ['The harbour was quiet.', 'Rain came late.']))
    await index.syncAll()
    const blocks = index.pendingEmbeddings(10)
    index.writeEmbedding(blocks[0]!.docId, blocks[0]!.blockIndex, blocks[0]!.text, axis(0))
    index.writeEmbedding(blocks[1]!.docId, blocks[1]!.blockIndex, blocks[1]!.text, axis(1))

    const hits = index.nearestBlocks(axis(0), 5)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      path: 'a.pubdoc',
      title: 'Harbour',
      blockIndex: 0,
      text: 'The harbour was quiet.'
    })
    expect(hits[0]!.score).toBeCloseTo(1, 5)
  })

  it('returns nothing when the query vector has a different width', async () => {
    // Reachable by changing the embedding model: the stored vectors keep their
    // old width until the index is rebuilt. Nothing matches, rather than a
    // crash mid-search.
    await write('a.pubdoc', document('doc-e5', 'A', ['The harbour was quiet.']))
    await index.syncAll()
    const block = index.pendingEmbeddings(1)[0]!
    index.writeEmbedding(block.docId, block.blockIndex, block.text, axis(0, 4))

    expect(index.nearestBlocks(axis(0, 8), 5)).toEqual([])
  })

  it('forgets a document’s vectors when the file goes away', async () => {
    await write('a.pubdoc', document('doc-e6', 'A', ['The harbour was quiet.']))
    await index.syncAll()
    const block = index.pendingEmbeddings(1)[0]!
    index.writeEmbedding(block.docId, block.blockIndex, block.text, axis(0))

    await adapter.delete('a.pubdoc')
    await index.syncAll()
    expect(index.embeddingCoverage()).toEqual({ embedded: 0, total: 0 })
  })

  it('rebuilds from empty when the schema version moves', async () => {
    await write('a.pubdoc', document('doc-e7', 'A', ['The harbour was quiet.']))
    await index.syncAll()
    const block = index.pendingEmbeddings(1)[0]!
    index.writeEmbedding(block.docId, block.blockIndex, block.text, axis(0))
    index.close()

    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(dbPath())
    raw.exec('PRAGMA user_version = 2')
    raw.close()

    // Adding a table without dropping `files` would leave it permanently empty
    // on every existing project, because `syncAll` diffs mtimes.
    index = new SearchIndexService(adapter, dbPath(), () => {}, () => roster)
    expect(index.embeddingCoverage()).toEqual({ embedded: 0, total: 0 })
    await index.syncAll()
    expect(index.embeddingCoverage()).toEqual({ embedded: 0, total: 1 })
  })
})
