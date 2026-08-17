import { describe, it, expect } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { exportEpub, type ExportDocument } from './toEpub.js'
import { XHTML_NODE_TYPES, XHTML_MARK_TYPES } from './xhtml.js'
import { EDITOR_NODE_TYPES, EDITOR_MARK_TYPES } from '../docx/toDocx.js'
import { buildToc, tocEntryLabel } from '../../shared/pm/toc.js'
import { BUILTIN_STYLES } from '../../shared/model/style.js'
import type { PmDoc, PmNode } from '../../shared/model/document.js'
import type { Publication } from '../../shared/model/manifest.js'

const PUBLICATION: Publication = { authorName: 'A. Author', language: 'en' }

function doc(...blocks: PmNode[]): PmDoc {
  return { type: 'doc', content: blocks }
}

function para(text: string, attrs?: Record<string, unknown>, marks?: PmNode['marks']): PmNode {
  return {
    type: 'paragraph',
    ...(attrs ? { attrs } : {}),
    content: [{ type: 'text', text, ...(marks ? { marks } : {}) }]
  }
}

async function write(documents: ExportDocument[]): Promise<Buffer> {
  return exportEpub({
    documents,
    styles: BUILTIN_STYLES,
    publication: PUBLICATION,
    title: 'Test Book',
    bookId: 'test-book-id'
  })
}

function unzip(buffer: Buffer): Record<string, string> {
  const raw = unzipSync(new Uint8Array(buffer))
  const out: Record<string, string> = {}
  for (const [path, bytes] of Object.entries(raw)) out[path] = strFromU8(bytes)
  return out
}

describe('exportEpub', () => {
  it('produces a real EPUB container', async () => {
    const files = unzip(await write([{ title: 'Chapter One', content: doc(para('Hello.')) }]))
    expect(files['mimetype']).toBe('application/epub+zip')
    expect(files['META-INF/container.xml']).toContain('OEBPS/content.opf')
    expect(files['OEBPS/content.opf']).toBeDefined()
    expect(files['OEBPS/nav.xhtml']).toBeDefined()
    expect(files['OEBPS/toc.ncx']).toBeDefined()
    expect(files['OEBPS/text/chapter-1.xhtml']).toContain('Hello.')
  })

  it('orders the spine exactly as the documents were given, front and back matter included', async () => {
    const documents: ExportDocument[] = [
      { title: 'Title Page', content: doc(para('By A. Author')) },
      { title: 'Chapter One', content: doc(para('Once upon a time.')) },
      { title: 'Chapter Two', content: doc(para('And then.')) },
      { title: 'Bibliography', content: doc(para('Works cited.')) }
    ]
    const files = unzip(await write(documents))
    const opf = files['OEBPS/content.opf']!
    const spineOrder = [...opf.matchAll(/<itemref idref="(chap\d+)"\/>/g)].map((m) => m[1])
    expect(spineOrder).toEqual(['chap1', 'chap2', 'chap3', 'chap4'])
    // Manifest hrefs line up with spine order, one XHTML file per document.
    documents.forEach((document, index) => {
      expect(files[`OEBPS/text/chapter-${index + 1}.xhtml`]).toContain(document.title)
    })
  })

  it('builds nav.xhtml from the same buildToc output as the in-app contents panel', async () => {
    const content = doc(
      { type: 'heading', attrs: { level: 1, styleId: 'chapter-title' }, content: [{ type: 'text', text: 'Chapter One' }] },
      para('Body text.')
    )
    const files = unzip(await write([{ title: 'Chapter One', content }]))
    const expected = buildToc(content, BUILTIN_STYLES).map(tocEntryLabel)
    for (const label of expected) {
      expect(files['OEBPS/nav.xhtml']).toContain(label)
      expect(files['OEBPS/toc.ncx']).toContain(label)
    }
  })

  it('pairs a footnote marker with its backlinked aside', async () => {
    const content = doc(
      para('A claim.'),
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'more claim' },
          { type: 'footnote', content: [para('The supporting note.')] }
        ]
      }
    )
    const files = unzip(await write([{ title: 'Chapter One', content }]))
    const xhtml = files['OEBPS/text/chapter-1.xhtml']!
    expect(xhtml).toMatch(/id="c1-fn1-ref" href="#c1-fn1"/)
    expect(xhtml).toMatch(/epub:type="footnote" id="c1-fn1"/)
    expect(xhtml).toContain('The supporting note.')
    // The backlink returns to the reference, completing the pair.
    expect(xhtml).toMatch(/href="#c1-fn1-ref"/)
  })

  it('produces byte-identical output across two exports of the same input', async () => {
    const documents: ExportDocument[] = [{ title: 'Chapter One', content: doc(para('Deterministic.')) }]
    const first = await write(documents)
    const second = await write(documents)
    expect(Buffer.compare(first, second)).toBe(0)
  })

  it('exports a field node as its text child, with no special case', async () => {
    const content = doc({
      type: 'paragraph',
      content: [{ type: 'field', attrs: { kind: 'wordCount' }, content: [{ type: 'text', text: '1,234' }] }]
    })
    const files = unzip(await write([{ title: 'Chapter One', content }]))
    expect(files['OEBPS/text/chapter-1.xhtml']).toContain('1,234')
  })
})

describe('the closed world the editor allows', () => {
  it('handles every node and mark type EPUB shares with the editor schema', () => {
    // The suggested-edit marks (`insertion`/`deletion`) are the one
    // deliberate gap: a reflowable book has no reviewer, so they degrade to
    // plain text, the same trade `toDocx.ts` documents for `mention`.
    const editorNodes = [...EDITOR_NODE_TYPES]
    const editorMarks = [...EDITOR_MARK_TYPES]
    expect(editorNodes.filter((type) => !XHTML_NODE_TYPES.has(type))).toEqual([])
    expect(editorMarks.filter((type) => !XHTML_MARK_TYPES.has(type))).toEqual([])
  })
})
