import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { unzipSync, strFromU8 } from 'fflate'
import { EpubService } from './epubService.js'
import { DocumentService } from './documentService.js'
import { SnapshotService } from './snapshotService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { DOC_EXT } from '../../shared/constants.js'
import { BUILTIN_STYLES } from '../../shared/model/style.js'
import { projectManifestSchema, type ProjectManifest } from '../../shared/model/manifest.js'
import type { ExportItem } from '../../shared/model/manuscript.js'

let root: string
let adapter: LocalAdapter
let documents: DocumentService
let epub: EpubService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-epub-'))
  adapter = new LocalAdapter(root)
  documents = new DocumentService(adapter, new SnapshotService(adapter))
  epub = new EpubService(adapter, documents)
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

function manifest(patch: Partial<ProjectManifest> = {}): ProjectManifest {
  return projectManifestSchema.parse({
    id: 'proj-1',
    name: 'Test Book',
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    styles: BUILTIN_STYLES,
    publication: { authorName: 'A. Author', language: 'en' },
    ...patch
  })
}

function unzip(buffer: Buffer): Record<string, string> {
  const raw = unzipSync(new Uint8Array(buffer))
  const out: Record<string, string> = {}
  for (const [filePath, bytes] of Object.entries(raw)) out[filePath] = strFromU8(bytes)
  return out
}

describe('EpubService', () => {
  it('exports front matter, a chapter with a footnote, and a bibliography entry as a valid EPUB', async () => {
    const titlePage = await documents.create(`title-page${DOC_EXT}`, 'Title Page')
    await documents.write(
      titlePage.path,
      {
        ...titlePage.doc,
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Test Book, by A. Author' }] }]
        }
      },
      titlePage.mtime
    )

    const chapter = await documents.create(`chapter-one${DOC_EXT}`, 'Chapter One')
    await documents.write(
      chapter.path,
      {
        ...chapter.doc,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Once upon a time.' },
                {
                  type: 'footnote',
                  attrs: { id: 'fn1' },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A note.' }] }]
                }
              ]
            }
          ]
        }
      },
      chapter.mtime
    )

    const bibliography = await documents.create(`bibliography${DOC_EXT}`, 'Bibliography')
    await documents.write(
      bibliography.path,
      {
        ...bibliography.doc,
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Works cited.' }] }]
        }
      },
      bibliography.mtime
    )

    const items: ExportItem[] = [
      { kind: 'document', path: titlePage.path },
      { kind: 'heading', title: 'Part One', level: 1, numbered: false },
      { kind: 'document', path: chapter.path },
      { kind: 'document', path: bibliography.path }
    ]

    const outFile = path.join(root, 'out', 'book.epub')
    await epub.export(items, outFile, manifest())

    const bytes = await fs.readFile(outFile)
    const files = unzip(bytes)

    expect(files['mimetype']).toBe('application/epub+zip')
    expect(files['META-INF/container.xml']).toContain('OEBPS/content.opf')
    expect(files['OEBPS/content.opf']).toContain('A. Author')
    expect(files['OEBPS/nav.xhtml']).toBeDefined()
    expect(files['OEBPS/toc.ncx']).toBeDefined()

    const spineOrder = [...files['OEBPS/content.opf']!.matchAll(/<itemref idref="(chap\d+)"\/>/g)].map((m) => m[1])
    expect(spineOrder).toEqual(['chap1', 'chap2', 'chap3', 'chap4'])

    expect(files['OEBPS/text/chapter-1.xhtml']).toContain('Title Page')
    expect(files['OEBPS/text/chapter-2.xhtml']).toContain('Part One')
    expect(files['OEBPS/text/chapter-3.xhtml']).toContain('Once upon a time.')
    expect(files['OEBPS/text/chapter-3.xhtml']).toContain('epub:type="footnote"')
    expect(files['OEBPS/text/chapter-3.xhtml']).toContain('A note.')
    expect(files['OEBPS/text/chapter-4.xhtml']).toContain('Works cited.')
  })

  it('writes a cover image when the manifest names one', async () => {
    const coverBytes = Buffer.from([137, 80, 78, 71])
    const assetPath = await documents.writeAsset(coverBytes.toString('base64'), 'png')

    const chapter = await documents.create(`chapter-one${DOC_EXT}`, 'Chapter One')
    await documents.write(
      chapter.path,
      { ...chapter.doc, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello.' }] }] } },
      chapter.mtime
    )

    const outFile = path.join(root, 'book.epub')
    await epub.export(
      [{ kind: 'document', path: chapter.path }],
      outFile,
      manifest({ publication: { coverImagePath: assetPath, authorName: 'A. Author' } })
    )

    const files = unzip(await fs.readFile(outFile))
    expect(files['OEBPS/images/cover.png']).toBeDefined()
    expect(files['OEBPS/content.opf']).toContain('cover-image')
  })
})
