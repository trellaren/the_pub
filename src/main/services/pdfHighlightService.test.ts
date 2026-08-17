import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { PdfHighlightService } from './pdfHighlightService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'

let root: string
let adapter: LocalAdapter
let service: PdfHighlightService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-pdf-highlights-'))
  adapter = new LocalAdapter(root)
  service = new PdfHighlightService(adapter)
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('PdfHighlightService', () => {
  it('saves a new highlight and lists it back', async () => {
    const highlight = await service.save('src1', 'att1', {
      color: '#ffef8a',
      quote: 'the quick brown fox',
      page: 2,
      rects: [[0, 0, 10, 10]]
    })

    expect(highlight.page).toBe(2)
    expect(await service.listForAttachment('src1', 'att1')).toEqual([highlight])
  })

  it('updates in place when saved again with the same id', async () => {
    const first = await service.save('src1', 'att1', { color: '#ffef8a', quote: 'a quote', page: 1 })
    const updated = await service.save('src1', 'att1', { id: first.id, color: '#ffef8a', quote: 'a quote', page: 1, categoryId: 'evidence' })

    const all = await service.listForAttachment('src1', 'att1')
    expect(all).toHaveLength(1)
    expect(all[0]!.categoryId).toBe('evidence')
    expect(updated.created).toBe(first.created)
  })

  it('removes a highlight by id', async () => {
    const highlight = await service.save('src1', 'att1', { color: '#ffef8a', quote: 'x', page: 1 })
    await service.remove('src1', 'att1', highlight.id)
    expect(await service.listForAttachment('src1', 'att1')).toEqual([])
  })

  it('reconciles by following the quote to a new page and clearing orphaned status', async () => {
    const highlight = await service.save('src1', 'att1', { color: '#ffef8a', quote: 'the quick brown fox', page: 1 })

    const result = await service.reconcile('src1', 'att1', [
      { page: 1, text: 'nothing relevant' },
      { page: 4, text: 'saw the quick brown fox jump' }
    ])

    expect(result).not.toBeNull()
    expect(result![0]!.page).toBe(4)
    expect(result![0]!.orphaned).toBe(false)
    expect(highlight.page).toBe(1) // the original save is untouched; only the sidecar changed
  })

  it('orphans a highlight whose quote is gone and whose stored page no longer exists', async () => {
    await service.save('src1', 'att1', { color: '#ffef8a', quote: 'gone forever', page: 9 })

    const result = await service.reconcile('src1', 'att1', [{ page: 1, text: 'completely different text' }])

    expect(result![0]!.orphaned).toBe(true)
  })

  it('persists highlights across service instances via the sidecar file', async () => {
    await service.save('src1', 'att1', { color: '#ffef8a', quote: 'persisted', page: 3 })

    const reopened = new PdfHighlightService(adapter)
    expect(await reopened.listForAttachment('src1', 'att1')).toHaveLength(1)
  })

  it('saves a capture highlight with kind/offset instead of page/rects', async () => {
    const highlight = await service.save('src1', 'att1', {
      kind: 'capture',
      color: '#ffef8a',
      quote: 'the quick brown fox',
      offset: 4
    })

    expect(highlight.kind).toBe('capture')
    expect(highlight.offset).toBe(4)
    expect(highlight.page).toBe(0)
  })

  it('reconcileCapture follows the quote to its offset and clears orphaned status', async () => {
    await service.save('src1', 'att1', { kind: 'capture', color: '#ffef8a', quote: 'lazy dog', offset: 999 })

    const result = await service.reconcileCapture('src1', 'att1', 'the quick brown fox and the lazy dog')

    expect(result).not.toBeNull()
    expect(result![0]!.orphaned).toBe(false)
    expect(result![0]!.offset).toBe('the quick brown fox and the lazy dog'.indexOf('lazy dog'))
  })

  it('reconcileCapture orphans a capture highlight whose quote is gone', async () => {
    await service.save('src1', 'att1', { kind: 'capture', color: '#ffef8a', quote: 'gone forever', offset: 0 })

    const result = await service.reconcileCapture('src1', 'att1', 'completely different text')

    expect(result![0]!.orphaned).toBe(true)
  })

  it('reconcileCapture leaves pdf highlights in the same file untouched', async () => {
    await service.save('src1', 'att1', { color: '#ffef8a', quote: 'a pdf quote', page: 1 })
    const result = await service.reconcileCapture('src1', 'att1', 'irrelevant text')
    expect(result).toBeNull()
  })
})
