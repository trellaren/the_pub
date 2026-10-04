import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DocumentService } from './documentService.js'
import { SnapshotService } from './snapshotService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { EMPTY_DOC, type PubDocument } from '../../shared/model/document.js'
import { FORMAT_VERSIONS, DOC_EXT } from '../../shared/constants.js'

let root: string
let adapter: LocalAdapter
let documents: DocumentService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-documents-'))
  adapter = new LocalAdapter(root)
  documents = new DocumentService(adapter, new SnapshotService(adapter))
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

function envelope(patch: Partial<PubDocument> & { docId: string }): PubDocument {
  const now = new Date().toISOString()
  return {
    formatVersion: FORMAT_VERSIONS.document,
    title: 'Untitled',
    created: now,
    modified: now,
    wordCount: 0,
    content: EMPTY_DOC,
    ...patch
  }
}

describe('DocumentService', () => {
  it('writes a new document and reads it back', async () => {
    const created = await documents.create(`chapter-one${DOC_EXT}`, 'Chapter One')
    expect(created.doc.title).toBe('Chapter One')

    const written = await documents.write(
      created.path,
      { ...created.doc, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Once upon a time' }] }] } },
      created.mtime
    )
    expect(written.ok).toBe(true)

    const reloaded = await documents.read(created.path)
    expect(reloaded.doc.wordCount).toBe(4)
  })

  it('refuses a write when the file changed on disk since it was last seen', async () => {
    const created = await documents.create(`chapter-one${DOC_EXT}`, 'Chapter One')
    // Stand in for an edit made outside the app: content changes and the
    // mtime moves forward by a known amount, without going through this
    // service — deterministic, unlike racing the clock with a real delay.
    const absolute = path.join(root, created.path)
    await fs.writeFile(absolute, JSON.stringify(envelope({ docId: created.doc.docId, title: 'Changed elsewhere' })), 'utf8')
    await fs.utimes(absolute, new Date(), new Date(Date.now() + 5000))

    const result = await documents.write(created.path, created.doc, created.mtime)
    expect(result).toMatchObject({ ok: false, reason: 'conflict' })
  })

  it('refuses to overwrite a file written by a newer version of Quoth, and leaves it untouched', async () => {
    const docPath = `newer${DOC_EXT}`
    const tooNew = envelope({ docId: 'doc-1', formatVersion: FORMAT_VERSIONS.document + 1, title: 'From the future' })
    await adapter.writeFileAtomic(docPath, Buffer.from(`${JSON.stringify(tooNew, null, 2)}\n`, 'utf8'))
    const beforeStat = await adapter.stat(docPath)
    const onDiskBefore = await adapter.readFile(docPath)

    const result = await documents.write(
      docPath,
      envelope({ docId: 'doc-1', title: 'An edit this build wants to make' }),
      beforeStat?.mtime ?? null
    )

    expect(result).toEqual({ ok: false, reason: 'format-too-new', diskVersion: FORMAT_VERSIONS.document + 1 })

    const onDiskAfter = await adapter.readFile(docPath)
    expect(onDiskAfter.equals(onDiskBefore)).toBe(true)
  })

  it('does not snapshot a version it refused to read past', async () => {
    const docPath = `newer${DOC_EXT}`
    const tooNew = envelope({ docId: 'doc-1', formatVersion: FORMAT_VERSIONS.document + 1 })
    await adapter.writeFileAtomic(docPath, Buffer.from(`${JSON.stringify(tooNew, null, 2)}\n`, 'utf8'))

    await documents.write(docPath, envelope({ docId: 'doc-1' }), null)

    const snapshots = new SnapshotService(adapter)
    expect(await snapshots.list('doc-1')).toEqual([])
  })

  it('still opens (reads) a too-new document — only writing it back is refused', async () => {
    const docPath = `newer${DOC_EXT}`
    const tooNew = envelope({ docId: 'doc-1', formatVersion: FORMAT_VERSIONS.document + 1, title: 'Readable' })
    await adapter.writeFileAtomic(docPath, Buffer.from(`${JSON.stringify(tooNew, null, 2)}\n`, 'utf8'))

    const loaded = await documents.read(docPath)
    expect(loaded.doc.title).toBe('Readable')
  })
})

describe('the provenance log', () => {
  const entry = (id: string) => ({
    id,
    runId: 'r',
    authorId: 'assistant-a',
    model: 'm',
    at: '2026-10-02T00:00:00.000Z',
    mode: 'direct' as const,
    blockIndex: 0,
    chars: 3,
    excerpt: 'abc',
    reason: ''
  })

  it('cannot be shortened by a write — entries on disk come along whatever the caller sends', async () => {
    const created = await documents.create(`chapter${DOC_EXT}`)
    const first = await documents.write(created.path, { ...created.doc, provenance: [entry('a')] }, created.mtime)
    expect(first.ok).toBe(true)

    // A renderer holding a stale envelope with no log at all.
    const stale = await documents.write(created.path, { ...created.doc }, first.ok ? first.mtime : null)
    expect(stale.ok).toBe(true)
    expect((await documents.read(created.path)).doc.provenance?.map((item) => item.id)).toEqual(['a'])

    // A later write adds, in order, without duplicating.
    const more = await documents.write(
      created.path,
      { ...created.doc, provenance: [entry('a'), entry('b')] },
      stale.ok ? stale.mtime : null
    )
    expect(more.ok).toBe(true)
    expect((await documents.read(created.path)).doc.provenance?.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('leaves a document that never had assistant prose without a log', async () => {
    const created = await documents.create(`plain${DOC_EXT}`)
    await documents.write(created.path, created.doc, created.mtime)
    expect((await documents.read(created.path)).doc.provenance).toBeUndefined()
  })

  it('retries a read whose file changed between the stats around it', async () => {
    const created = await documents.create(`chapter-one${DOC_EXT}`, 'Chapter One')
    const absolute = path.join(root, created.path)
    let reads = 0
    const racing = Object.create(adapter) as LocalAdapter
    racing.readFile = async (target: string) => {
      const bytes = await adapter.readFile(target)
      reads += 1
      if (reads === 1) {
        const later = new Date(Date.now() + 60_000)
        await fs.utimes(absolute, later, later)
      }
      return bytes
    }
    const service = new DocumentService(racing, new SnapshotService(adapter))
    const loaded = await service.read(created.path)
    expect(reads).toBe(2)
    expect(loaded.mtime).toBe((await adapter.stat(created.path))?.mtime)
  })

  it('lets only one of two concurrent saves with the same baseline through', async () => {
    const created = await documents.create(`chapter-one${DOC_EXT}`, 'Chapter One')
    const later = new Date(created.mtime + 5_000)
    const absolute = path.join(root, created.path)
    const slow = Object.create(adapter) as LocalAdapter
    slow.writeFileAtomic = async (target: string, data: Buffer) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await adapter.writeFileAtomic(target, data)
      await fs.utimes(absolute, later, later)
    }
    const service = new DocumentService(slow, new SnapshotService(adapter))
    const [first, second] = await Promise.all([
      service.write(created.path, { ...created.doc, title: 'A' }, created.mtime),
      service.write(created.path, { ...created.doc, title: 'B' }, created.mtime)
    ])
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, reason: 'conflict' })
  })
})
