import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { HighlightService } from './highlightService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import type { PmDoc } from '../../shared/model/document.js'

let root: string
let adapter: LocalAdapter
let highlights: HighlightService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-highlights-'))
  adapter = new LocalAdapter(root)
  highlights = new HighlightService(adapter)
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

function docWithHighlight(text: string, highlightId: string, color = 'yellow'): PmDoc {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text, marks: [{ type: 'highlight', attrs: { color, highlightId } }] }]
      }
    ]
  }
}

describe('HighlightService', () => {
  it('starts empty for a document with no highlights file', async () => {
    expect(await highlights.listForDoc('doc-1')).toEqual([])
  })

  it('collects a highlight and writes it under its own document file', async () => {
    const highlight = await highlights.collect('doc-1', 'h1', {
      color: 'yellow',
      quote: 'the important part',
      blockIndex: 2
    })
    expect(highlight.docId).toBe('doc-1')
    expect(highlight.highlightId).toBe('h1')
    expect(highlight.orphaned).toBe(false)
    expect(highlight.created).toBe(highlight.modified)

    const file = await fs.readFile(path.join(root, '.thepub', 'highlights', 'doc-1.json'), 'utf8')
    expect(JSON.parse(file).highlights[0].id).toBe(highlight.id)
  })

  it('collecting the same highlightId twice updates in place rather than duplicating', async () => {
    await highlights.collect('doc-1', 'h1', { color: 'yellow', quote: 'a', blockIndex: 0, categoryId: 'evidence' })
    const updated = await highlights.collect('doc-1', 'h1', { color: 'green', quote: 'a', blockIndex: 0 })
    const list = await highlights.listForDoc('doc-1')
    expect(list).toHaveLength(1)
    expect(updated.color).toBe('green')
  })

  it('does not mix highlights belonging to different documents', async () => {
    await highlights.collect('doc-1', 'h1', { color: 'yellow', quote: 'one', blockIndex: 0 })
    await highlights.collect('doc-2', 'h2', { color: 'yellow', quote: 'two', blockIndex: 0 })
    expect(await highlights.listForDoc('doc-1')).toHaveLength(1)
    expect(await highlights.listForDoc('doc-2')).toHaveLength(1)
  })

  it('saves an edit to a highlight, keeping its creation date', async () => {
    const highlight = await highlights.collect('doc-1', 'h1', { color: 'yellow', quote: 'original', blockIndex: 0 })
    const saved = await highlights.save('doc-1', { ...highlight, note: 'worth quoting' })
    expect(saved.note).toBe('worth quoting')
    expect(saved.created).toBe(highlight.created)
    expect(saved.modified).not.toBe(highlight.created)
  })

  it('removes a highlight', async () => {
    const highlight = await highlights.collect('doc-1', 'h1', { color: 'yellow', quote: 'gone soon', blockIndex: 0 })
    await highlights.remove('doc-1', highlight.id)
    expect(await highlights.listForDoc('doc-1')).toEqual([])
  })

  it('survives being reloaded from disk', async () => {
    await highlights.collect('doc-1', 'h1', { color: 'yellow', quote: 'persisted', blockIndex: 0 })
    const reloaded = new HighlightService(adapter)
    expect(await reloaded.listForDoc('doc-1')).toHaveLength(1)
  })

  describe('reconcile', () => {
    it('does nothing, and reports no change, for a document with no highlights', async () => {
      expect(await highlights.reconcile('doc-1', docWithHighlight('irrelevant', 'x'))).toBeNull()
    })

    it('marks a highlight orphaned when its id is gone, and reports the change', async () => {
      const highlight = await highlights.collect('doc-1', 'h1', {
        color: 'yellow',
        quote: 'the marked text',
        blockIndex: 0
      })
      const result = await highlights.reconcile('doc-1', {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'no mark here' }] }]
      })
      expect(result).toHaveLength(1)
      expect(result![0]).toMatchObject({ id: highlight.id, orphaned: true })
      expect((await highlights.listForDoc('doc-1'))[0]).toMatchObject({ id: highlight.id, orphaned: true })
    })

    it('reports no change when every highlight already resolves to the same place', async () => {
      await highlights.collect('doc-1', 'h1', { color: 'yellow', quote: 'the marked text', blockIndex: 0 })
      const content = docWithHighlight('the marked text', 'h1')
      expect(await highlights.reconcile('doc-1', content)).toBeNull()
    })

    it('refreshes quote and blockIndex when the surrounding prose shifted but the mark is still there', async () => {
      const highlight = await highlights.collect('doc-1', 'h1', { color: 'yellow', quote: 'stale text', blockIndex: 0 })
      const content: PmDoc = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'a new paragraph before it' }] },
          docWithHighlight('the marked text', 'h1').content![0]!
        ]
      }
      const result = await highlights.reconcile('doc-1', content)
      expect(result).not.toBeNull()
      expect(result![0]).toMatchObject({ id: highlight.id, quote: 'the marked text', blockIndex: 1, orphaned: false })
    })

    it('un-orphans a highlight once its id is found again', async () => {
      const highlight = await highlights.collect('doc-1', 'h1', { color: 'yellow', quote: 'text', blockIndex: 0 })
      await highlights.reconcile('doc-1', {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'gone' }] }]
      })
      expect((await highlights.listForDoc('doc-1'))[0]!.orphaned).toBe(true)

      const recovered = await highlights.reconcile('doc-1', docWithHighlight('back again', 'h1'))
      expect(recovered![0]).toMatchObject({ id: highlight.id, orphaned: false, quote: 'back again' })
    })
  })

  describe('id allocation', () => {
    it('is stamped only when a highlight is collected, never implied by an uncollected mark', async () => {
      // A plain highlight mark with no `highlightId` attribute has nothing to
      // reconcile against — `collect` is the only path that creates a record.
      const content = docWithHighlight('plain yellow, never collected', '')
      expect(content.content![0]!.content![0]!.marks![0]!.attrs).toEqual({ color: 'yellow', highlightId: '' })
      expect(await highlights.listForDoc('doc-1')).toEqual([])
    })
  })
})
