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
