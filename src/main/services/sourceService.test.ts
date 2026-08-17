import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SourceService, attachmentDir, attachmentPdfPath, attachmentCapturePath } from './sourceService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { SOURCES_FILE, FORMAT_VERSIONS, IGNORED_DIRS, RESEARCH_DIR } from '../../shared/constants.js'
import { sourceFileSchema, type CslItem } from '../../shared/model/source.js'
import { PUB_ATTACHMENTS_KEY } from '../../shared/model/research.js'

let root: string
let adapter: LocalAdapter
let sources: SourceService

const book = (id: string, title: string): CslItem => ({ id, type: 'book', title })

async function onDisk(): Promise<CslItem[]> {
  const raw = await fs.readFile(path.join(root, SOURCES_FILE), 'utf8')
  return sourceFileSchema.parse(JSON.parse(raw)).sources
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-sources-'))
  adapter = new LocalAdapter(root)
  sources = new SourceService(adapter)
  await sources.load()
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('SourceService.merge', () => {
  it('adds new sources and writes them through', async () => {
    const result = await sources.merge([book('a', 'Alpha'), book('b', 'Beta')])

    expect(result).toEqual({ added: 2, replaced: 0, skipped: 0 })
    expect((await onDisk()).map((item) => item.id)).toEqual(['a', 'b'])
  })

  /*
   * Importing the same file twice is an ordinary thing to do, and doubling the
   * library for it would be the kind of failure someone has to clean up by
   * hand.
   */
  it('replaces rather than duplicating a source it already holds', async () => {
    await sources.merge([book('a', 'Alpha')])
    const result = await sources.merge([book('a', 'Alpha, corrected')])

    expect(result).toEqual({ added: 0, replaced: 1, skipped: 0 })
    const stored = await onDisk()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.title).toBe('Alpha, corrected')
  })

  it('counts a mixed import as part added and part replaced', async () => {
    await sources.merge([book('a', 'Alpha')])
    expect(await sources.merge([book('a', 'Alpha again'), book('c', 'Gamma')])).toEqual({
      added: 1,
      replaced: 1,
      skipped: 0
    })
  })

  // One bad record must not cost someone the rest of a four-hundred-entry file.
  it('skips an unusable record and keeps the rest', async () => {
    const result = await sources.merge([
      book('a', 'Alpha'),
      { type: 'book', title: 'No id at all' } as CslItem,
      book('c', 'Gamma')
    ])

    expect(result).toEqual({ added: 2, replaced: 0, skipped: 1 })
    expect((await onDisk()).map((item) => item.id)).toEqual(['a', 'c'])
  })

  it('leaves hand-created sources alone', async () => {
    const created = await sources.create('article-journal')
    await sources.merge([book('imported', 'Imported')])

    expect((await onDisk()).map((item) => item.id)).toEqual([created.id, 'imported'])
  })

  it('writes nothing when there is nothing to merge', async () => {
    expect(await sources.merge([])).toEqual({ added: 0, replaced: 0, skipped: 0 })
    await expect(fs.stat(path.join(root, SOURCES_FILE))).rejects.toThrow()
  })

  /*
   * `merge` loads before it writes. Without that, a merge arriving before
   * anything had read the file would flush a library containing only the
   * imported entries, silently discarding what was already there.
   */
  it('does not discard sources written before this service read the file', async () => {
    await sources.merge([book('existing', 'Already here')])

    const second = new SourceService(adapter)
    await second.merge([book('fresh', 'Newly imported')])

    expect((await onDisk()).map((item) => item.id)).toEqual(['existing', 'fresh'])
  })

  it('stamps the current format version on what it writes', async () => {
    await sources.merge([book('a', 'Alpha')])
    const raw = JSON.parse(await fs.readFile(path.join(root, SOURCES_FILE), 'utf8'))
    expect(raw.formatVersion).toBe(FORMAT_VERSIONS.sources)
  })
})

describe('SourceService attachments', () => {
  it('resolves attachment paths under .thepub/research/<sourceId>/', () => {
    expect(attachmentDir('src1')).toBe(`${RESEARCH_DIR}/src1`)
    expect(attachmentPdfPath('src1', 'att1')).toBe(`${RESEARCH_DIR}/src1/att1.pdf`)
    expect(attachmentCapturePath('src1', 'att1')).toBe(`${RESEARCH_DIR}/src1/att1.capture.json`)
  })

  it('writes a PDF attachment through the VfsAdapter and indexes it on the source', async () => {
    const source = await sources.create('article-journal')
    const bytes = Buffer.from('%PDF-1.4 fake bytes')
    const attachment = await sources.addPdfAttachment(source.id, bytes, 'paper.pdf')

    expect(attachment.kind).toBe('pdf')
    const onDiskBytes = await fs.readFile(path.join(root, attachmentPdfPath(source.id, attachment.id)))
    expect(onDiskBytes.equals(bytes)).toBe(true)

    expect(sources.listAttachments(source.id)).toEqual([attachment])
    const stored = (await onDisk()).find((item) => item.id === source.id) as unknown as Record<string, unknown>
    expect(stored[PUB_ATTACHMENTS_KEY]).toEqual([attachment])
  })

  it('rides the attachment index in the catchall key so ordinary CSL fields are untouched', async () => {
    const source = await sources.create('book')
    await sources.save({ ...source, title: 'A Book' })
    await sources.addPdfAttachment(source.id, Buffer.from('bytes'), 'scan.pdf')

    const stored = (await onDisk()).find((item) => item.id === source.id)!
    expect(stored.title).toBe('A Book')
    expect(Object.keys(stored)).toContain(PUB_ATTACHMENTS_KEY)
  })

  it('writes a capture attachment and merges URL/accessed into the source', async () => {
    const source = await sources.create('webpage')
    const attachment = await sources.addCaptureAttachment(
      source.id,
      { url: 'https://example.com/a', title: 'A Page', text: 'body text', accessed: '2026-08-17' },
      'https://example.com/a'
    )

    expect(attachment.kind).toBe('capture')
    const capture = await sources.readCapture(source.id, attachment.id)
    expect(capture.text).toBe('body text')

    const stored = (await onDisk()).find((item) => item.id === source.id)!
    expect(stored.URL).toBe('https://example.com/a')
    expect(stored.accessed).toEqual({ 'date-parts': [[2026, 8, 17]] })
  })

  it('removes an attachment file and its index entry', async () => {
    const source = await sources.create('book')
    const attachment = await sources.addPdfAttachment(source.id, Buffer.from('bytes'), 'x.pdf')

    await sources.removeAttachment(source.id, attachment.id)

    expect(sources.listAttachments(source.id)).toEqual([])
    await expect(fs.readFile(path.join(root, attachmentPdfPath(source.id, attachment.id)))).rejects.toThrow()
  })

  /*
   * The load-bearing exclusion: `.thepub/research/` must never be walked by
   * the search indexer or shown in the file tree, the same way
   * `.thepub/notes/` and `.thepub/highlights/` already aren't. It rides the
   * same mechanism — `IGNORED_DIRS`' `.thepub` prefix in `walk` — rather than
   * a second, attachment-specific skip-list.
   */
  it('is excluded from adapter.walk the same way notes and highlights are', async () => {
    const source = await sources.create('book')
    await sources.addPdfAttachment(source.id, Buffer.from('bytes'), 'x.pdf')
    await fs.mkdir(path.join(root, 'chapters'), { recursive: true })
    await fs.writeFile(path.join(root, 'chapters/one.pubdoc'), '{}')

    const files = await adapter.walk('', IGNORED_DIRS)
    expect(files.some((entry) => entry.path.startsWith(RESEARCH_DIR))).toBe(false)
    expect(files.some((entry) => entry.path.endsWith('one.pubdoc'))).toBe(true)
  })
})
