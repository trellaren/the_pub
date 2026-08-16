import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { NoteService } from './noteService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { ANCHOR_MARK } from '../../shared/model/anchor.js'
import type { PmDoc } from '../../shared/model/document.js'

let root: string
let adapter: LocalAdapter
let notes: NoteService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-notes-'))
  adapter = new LocalAdapter(root)
  notes = new NoteService(adapter)
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

function docWithAnchor(text: string, anchorId: string): PmDoc {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text, marks: [{ type: ANCHOR_MARK, attrs: { anchorId } }] }]
      }
    ]
  }
}

describe('NoteService', () => {
  it('starts empty for a document with no notes file', async () => {
    expect(await notes.listForDoc('doc-1')).toEqual([])
  })

  it('creates a note and writes it under its own document file', async () => {
    const note = await notes.create('doc-1', 'anchor-1', 'the important part', 2)
    expect(note.docId).toBe('doc-1')
    expect(note.anchorId).toBe('anchor-1')
    expect(note.resolved).toBe(false)
    expect(note.orphaned).toBe(false)
    expect(note.created).toBe(note.modified)

    const file = await fs.readFile(path.join(root, '.thepub', 'notes', 'doc-1.json'), 'utf8')
    expect(JSON.parse(file).notes[0].id).toBe(note.id)
  })

  it('does not mix notes belonging to different documents', async () => {
    await notes.create('doc-1', 'a1', 'text one', 0)
    await notes.create('doc-2', 'a2', 'text two', 0)
    expect(await notes.listForDoc('doc-1')).toHaveLength(1)
    expect(await notes.listForDoc('doc-2')).toHaveLength(1)
  })

  it('saves an edit to a note, keeping its creation date', async () => {
    const note = await notes.create('doc-1', 'a1', 'original', 0)
    const saved = await notes.save('doc-1', { ...note, resolved: true })
    expect(saved.resolved).toBe(true)
    expect(saved.created).toBe(note.created)
    expect(saved.modified).not.toBe(note.created)
  })

  it('removes a note', async () => {
    const note = await notes.create('doc-1', 'a1', 'gone soon', 0)
    await notes.remove('doc-1', note.id)
    expect(await notes.listForDoc('doc-1')).toEqual([])
  })

  it('survives being reloaded from disk', async () => {
    await notes.create('doc-1', 'a1', 'persisted', 0)
    const reloaded = new NoteService(adapter)
    expect(await reloaded.listForDoc('doc-1')).toHaveLength(1)
  })

  describe('reconcile', () => {
    it('does nothing, and reports no change, for a document with no notes', async () => {
      expect(await notes.reconcile('doc-1', docWithAnchor('irrelevant', 'x'))).toBeNull()
    })

    it('marks a note orphaned when its anchor is gone, and reports the change', async () => {
      const note = await notes.create('doc-1', 'a1', 'the anchored text', 0)
      const result = await notes.reconcile('doc-1', {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'no anchor here' }] }]
      })
      expect(result).toHaveLength(1)
      expect(result![0]).toMatchObject({ id: note.id, orphaned: true })
      expect((await notes.listForDoc('doc-1'))[0]).toMatchObject({ id: note.id, orphaned: true })
    })

    it('reports no change when every note already resolves to the same place', async () => {
      await notes.create('doc-1', 'a1', 'the anchored text', 0)
      const content = docWithAnchor('the anchored text', 'a1')
      expect(await notes.reconcile('doc-1', content)).toBeNull()
    })

    it('refreshes anchorText and blockIndex when the surrounding prose shifted but the anchor is still there', async () => {
      const note = await notes.create('doc-1', 'a1', 'stale text', 0)
      const content: PmDoc = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'a new paragraph before it' }] },
          docWithAnchor('the anchored text', 'a1').content![0]!
        ]
      }
      const result = await notes.reconcile('doc-1', content)
      expect(result).not.toBeNull()
      expect(result![0]).toMatchObject({ id: note.id, anchorText: 'the anchored text', blockIndex: 1, orphaned: false })
    })

    it('un-orphans a note once its anchor is found again', async () => {
      const note = await notes.create('doc-1', 'a1', 'text', 0)
      await notes.reconcile('doc-1', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'gone' }] }] })
      expect((await notes.listForDoc('doc-1'))[0]!.orphaned).toBe(true)

      const recovered = await notes.reconcile('doc-1', docWithAnchor('back again', 'a1'))
      expect(recovered![0]).toMatchObject({ id: note.id, orphaned: false, anchorText: 'back again' })
    })
  })
})
