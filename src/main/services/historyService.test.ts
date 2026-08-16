import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { HistoryService } from './historyService.js'
import { DocumentService } from './documentService.js'
import { SnapshotService } from './snapshotService.js'
import { NoteService } from './noteService.js'
import type { SearchIndexService } from './searchIndexService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { pubDocumentSchema, type PubDocument } from '../../shared/model/document.js'
import { ANCHOR_MARK } from '../../shared/model/anchor.js'
import { SNAPSHOTS_DIR } from '../../shared/constants.js'

/**
 * Restoring a version, against a real adapter in a temporary directory.
 *
 * The index is stubbed to whatever the test wants `resolvePath` to say, since
 * what is under test is the read-archive-write sequence and what it refuses,
 * not the FTS query — which `searchIndexService.test.ts` covers.
 */

let root: string
let adapter: LocalAdapter
let documents: DocumentService
let snapshots: SnapshotService
let history: HistoryService
let notes: NoteService
let paths: Map<string, string>

function stubIndex(): SearchIndexService {
  return {
    resolvePath: (docId: string) => paths.get(docId) ?? null,
    indexDocument: async () => {}
  } as unknown as SearchIndexService
}

async function write(target: string, text: string): Promise<PubDocument> {
  const loaded = await documents.read(target)
  const next: PubDocument = {
    ...loaded.doc,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
  }
  const result = await documents.write(target, next, loaded.mtime)
  expect(result.ok).toBe(true)
  return next
}

function textOf(doc: PubDocument): string {
  return JSON.stringify(doc.content)
}

/**
 * The stored version whose text contains `needle`.
 *
 * Picked by content rather than by position, because `DocumentService.write`
 * archives the previous content on every save — so the list holds versions the
 * test never asked for, and its first entry is the empty document each file
 * starts life as.
 */
async function versionContaining(docId: string, needle: string): Promise<string> {
  for (const item of await snapshots.list(docId)) {
    const stored = await snapshots.read(docId, item.timestamp)
    if (textOf(stored).includes(needle)) return item.timestamp
  }
  throw new Error(`No stored version contains ${needle}`)
}

async function snapshotCount(docId: string): Promise<number> {
  const entries = await fs.readdir(path.join(root, SNAPSHOTS_DIR, docId)).catch(() => [])
  return entries.filter((name) => name.endsWith('.json')).length
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-history-'))
  adapter = new LocalAdapter(root)
  snapshots = new SnapshotService(adapter)
  documents = new DocumentService(adapter, snapshots)
  paths = new Map()
  // A real NoteService, not a stub: what the restore path has to get right is
  // that notes are actually re-anchored on disk, which a stub would assert
  // nothing about.
  notes = new NoteService(adapter)
  history = new HistoryService(documents, snapshots, stubIndex(), notes)
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('restoring in place', () => {
  it('brings the old content back', async () => {
    const created = await documents.create('chapter.pubdoc', 'Chapter')
    paths.set(created.doc.docId, created.path)
    await snapshots.forceSnapshot(await write('chapter.pubdoc', 'The first draft.'))
    await write('chapter.pubdoc', 'Something else entirely.')

    const result = await history.restoreInPlace(
      created.doc.docId,
      await versionContaining(created.doc.docId, 'The first draft.')
    )

    expect(result.ok).toBe(true)
    const now = await documents.read('chapter.pubdoc')
    expect(textOf(now.doc)).toContain('The first draft.')
  })

  it('keeps the document’s own identity rather than the snapshot’s', async () => {
    const created = await documents.create('chapter.pubdoc', 'Chapter')
    paths.set(created.doc.docId, created.path)
    await snapshots.forceSnapshot(await write('chapter.pubdoc', 'Draft.'))
    await write('chapter.pubdoc', 'Later.')

    await history.restoreInPlace(
      created.doc.docId,
      await versionContaining(created.doc.docId, 'Draft.')
    )

    // Its id is what the binder, the index and every open panel know it by.
    expect((await documents.read('chapter.pubdoc')).doc.docId).toBe(created.doc.docId)
    expect((await documents.read('chapter.pubdoc')).doc.created).toBe(created.doc.created)
  })

  /*
   * The reason `forceSnapshot` exists.
   *
   * `maybeSnapshot` is throttled so autosave cannot fill the history with
   * keystrokes, and a restore very often lands inside that window — the author
   * has just been typing. Archiving through the throttle would silently drop
   * the version being overwritten, which is exactly the one they will want back
   * if they restored the wrong thing. Swap `forceSnapshot` for `maybeSnapshot`
   * in the service and this fails.
   */
  it('archives what it is about to overwrite even moments after a save', async () => {
    const created = await documents.create('chapter.pubdoc', 'Chapter')
    paths.set(created.doc.docId, created.path)
    await snapshots.forceSnapshot(await write('chapter.pubdoc', 'The first draft.'))
    // A save just now, well inside the throttle window.
    await write('chapter.pubdoc', 'The version about to be replaced.')

    const target = await versionContaining(created.doc.docId, 'The first draft.')
    const before = await snapshotCount(created.doc.docId)
    await history.restoreInPlace(created.doc.docId, target)

    expect(await snapshotCount(created.doc.docId)).toBe(before + 1)
    const archived = await Promise.all(
      (await snapshots.list(created.doc.docId)).map((item) =>
        snapshots.read(created.doc.docId, item.timestamp)
      )
    )
    expect(archived.map(textOf).join(' ')).toContain('The version about to be replaced.')
  })

  it('refuses when the document is gone', async () => {
    expect(await history.restoreInPlace('nobody', '2026-01-01T00:00:00.000Z')).toEqual({
      ok: false,
      reason: 'missing-document'
    })
  })

  /* A document edited outside the app since the panel last looked is refused,
   * not quietly overwritten — the same guard every other write goes through. */
  it('refuses when the file changed underneath it', async () => {
    const created = await documents.create('chapter.pubdoc', 'Chapter')
    paths.set(created.doc.docId, created.path)
    await snapshots.forceSnapshot(await write('chapter.pubdoc', 'Draft.'))

    const target = await versionContaining(created.doc.docId, 'Draft.')
    // Stand in for another writer: the mtime the restore reads will be stale by
    // the time it writes, which is what the guard is looking for.
    const original = documents.read.bind(documents)
    documents.read = async (target: string) => {
      const loaded = await original(target)
      await fs.writeFile(
        path.join(root, target),
        JSON.stringify({ ...loaded.doc, title: 'Changed elsewhere' }),
        'utf8'
      )
      await fs.utimes(path.join(root, target), new Date(), new Date(Date.now() + 5000))
      documents.read = original
      return loaded
    }

    const result = await history.restoreInPlace(created.doc.docId, target)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('conflict')
  })
})

describe('restoring into a new file', () => {
  it('writes the old version beside the original, leaving it alone', async () => {
    const created = await documents.create('chapter.pubdoc', 'Chapter')
    paths.set(created.doc.docId, created.path)
    await snapshots.forceSnapshot(await write('chapter.pubdoc', 'The first draft.'))
    await write('chapter.pubdoc', 'The current draft.')

    const copy = await history.restoreToNewFile(
      created.doc.docId,
      await versionContaining(created.doc.docId, 'The first draft.'),
      'chapter-earlier.pubdoc'
    )

    expect(textOf(copy.doc)).toContain('The first draft.')
    expect(textOf((await documents.read('chapter.pubdoc')).doc)).toContain('The current draft.')
  })

  it('gives the copy its own identity, so it is a document and not a duplicate', async () => {
    const created = await documents.create('chapter.pubdoc', 'Chapter')
    paths.set(created.doc.docId, created.path)
    await snapshots.forceSnapshot(await write('chapter.pubdoc', 'Draft.'))

    const copy = await history.restoreToNewFile(
      created.doc.docId,
      await versionContaining(created.doc.docId, 'Draft.'),
      'chapter-copy.pubdoc'
    )

    // Sharing an id would make the index, the binder and every backlink treat
    // the two files as one document.
    expect(copy.doc.docId).not.toBe(created.doc.docId)
    expect(pubDocumentSchema.parse(copy.doc).docId).toBe(copy.doc.docId)
  })

  it('does not disturb the original’s history', async () => {
    const created = await documents.create('chapter.pubdoc', 'Chapter')
    paths.set(created.doc.docId, created.path)
    await snapshots.forceSnapshot(await write('chapter.pubdoc', 'Draft.'))
    const target = await versionContaining(created.doc.docId, 'Draft.')
    const before = await snapshotCount(created.doc.docId)

    await history.restoreToNewFile(created.doc.docId, target, 'copy.pubdoc')

    expect(await snapshotCount(created.doc.docId)).toBe(before)
  })
})

/*
 * The roadmap's Phase 2 requirement, and the one case the `doc:write` handler
 * cannot cover: restoring an old version resurrects the anchor ids it was
 * saved with, so recovery has to run again afterwards.
 */
describe('notes and a restore', () => {
  const ANCHOR_ID = 'anchor-1'

  /** A document whose sentence carries an `anchor` mark, or plain text without one. */
  async function writeAnchored(target: string, text: string, anchored: boolean): Promise<PubDocument> {
    const loaded = await documents.read(target)
    const next: PubDocument = {
      ...loaded.doc,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              anchored
                ? { type: 'text', text, marks: [{ type: ANCHOR_MARK, attrs: { anchorId: ANCHOR_ID } }] }
                : { type: 'text', text }
            ]
          }
        ]
      }
    }
    const result = await documents.write(target, next, loaded.mtime)
    expect(result.ok).toBe(true)
    return next
  }

  it('un-orphans a note when the version holding its anchor comes back', async () => {
    const created = await documents.create('chapter.pubdoc', 'Chapter')
    const docId = created.doc.docId
    paths.set(docId, created.path)

    const anchored = await writeAnchored('chapter.pubdoc', 'The anchored sentence.', true)
    await snapshots.forceSnapshot(anchored)
    await notes.create(docId, ANCHOR_ID, 'The anchored sentence.', 0)

    // The edit that loses the anchor, reconciled the way a normal save would.
    const stripped = await writeAnchored('chapter.pubdoc', 'Rewritten without it.', false)
    await notes.reconcile(docId, stripped.content)
    expect((await notes.listForDoc(docId))[0]!.orphaned).toBe(true)

    const result = await history.restoreInPlace(
      docId,
      await versionContaining(docId, 'The anchored sentence.')
    )

    expect(result.ok).toBe(true)
    expect(result.ok && result.notesChanged).toBe(true)
    expect((await notes.listForDoc(docId))[0]!.orphaned).toBe(false)
  })

  it('orphans a note when the restored version predates its anchor', async () => {
    const created = await documents.create('chapter.pubdoc', 'Chapter')
    const docId = created.doc.docId
    paths.set(docId, created.path)

    const before = await writeAnchored('chapter.pubdoc', 'Before the note existed.', false)
    await snapshots.forceSnapshot(before)
    await writeAnchored('chapter.pubdoc', 'The anchored sentence.', true)
    await notes.create(docId, ANCHOR_ID, 'The anchored sentence.', 0)

    const result = await history.restoreInPlace(
      docId,
      await versionContaining(docId, 'Before the note existed.')
    )

    expect(result.ok).toBe(true)
    // Marked, never deleted — re-attaching is the author's decision.
    expect((await notes.listForDoc(docId))[0]!.orphaned).toBe(true)
    expect(await notes.listForDoc(docId)).toHaveLength(1)
  })

  it('reports no note change for a document that has none', async () => {
    const created = await documents.create('chapter.pubdoc', 'Chapter')
    paths.set(created.doc.docId, created.path)
    await snapshots.forceSnapshot(await write('chapter.pubdoc', 'Draft.'))

    const result = await history.restoreInPlace(
      created.doc.docId,
      await versionContaining(created.doc.docId, 'Draft.')
    )

    expect(result.ok && result.notesChanged).toBe(false)
  })
})
