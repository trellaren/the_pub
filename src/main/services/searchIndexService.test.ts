import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SearchIndexService, toMatchExpression, buildSnippet } from './searchIndexService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import type { PubDocument } from '../../shared/model/document.js'

let root: string
let adapter: LocalAdapter
let index: SearchIndexService

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

async function write(docPath: string, doc: PubDocument): Promise<void> {
  await adapter.writeFile(docPath, Buffer.from(JSON.stringify(doc), 'utf8'))
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-index-'))
  adapter = new LocalAdapter(root)
  index = new SearchIndexService(adapter, path.join(root, '.thepub', 'index.db'), () => {})
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
