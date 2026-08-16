import { describe, it, expect } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { exportDocx, EDITOR_NODE_TYPES, EDITOR_MARK_TYPES } from './toDocx.js'
import { importDocx } from './fromDocx.js'
import { reconcileStyles } from './styleMap.js'
import { BUILTIN_STYLES } from '../../shared/model/style.js'
import type { PmDoc, PmNode } from '../../shared/model/document.js'
import { TINY_PNG } from './fixtures.js'

const PAGE = { width: 612, height: 792, margin: 72 }

async function write(content: PmDoc, title = 'Chapter One'): Promise<Buffer> {
  return exportDocx({
    documents: [{ title, content }],
    styles: BUILTIN_STYLES,
    page: PAGE,
    readImage: () => ({ data: TINY_PNG, type: 'png' })
  })
}

async function documentXml(content: PmDoc): Promise<string> {
  const zip = unzipSync(new Uint8Array(await write(content)))
  return strFromU8(zip['word/document.xml']!)
}

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

describe('exportDocx', () => {
  it('produces a real Word package, not just a zip', async () => {
    const zip = unzipSync(new Uint8Array(await write(doc(para('Hello.')))))
    // Word rejects a package missing any of these outright.
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']) {
      expect(Object.keys(zip)).toContain(part)
    }
  })

  it('writes the prose', async () => {
    expect(await documentXml(doc(para('The lighthouse keeper counted.')))).toContain(
      'The lighthouse keeper counted.'
    )
  })

  it('writes a field’s cached text as plain prose, with no field code at all', async () => {
    // No consumer of the export has to understand what a `field` is — its text
    // child is exported exactly like any other run, by the same fallback that
    // already carries an unrecognised node's prose through undamaged.
    const withField = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ' },
        {
          type: 'field',
          attrs: { kind: 'ref', targetBlockId: 'b1' },
          content: [{ type: 'text', text: 'Chapter Two' }]
        },
        { type: 'text', text: ' for more.' }
      ]
    })
    const xml = await documentXml(withField)
    // Each text node is still its own run — no field code, no bookmark, no
    // wrapper element of any kind — exactly what an unrecognised node with
    // real text content already gets by falling through to the same recursion.
    expect(xml).toContain('See ')
    expect(xml).toContain('Chapter Two')
    expect(xml).toContain(' for more.')
    expect(xml).not.toContain('fldChar')
    expect(xml).not.toContain('targetBlockId')
  })

  it('writes a footnote as a real Word footnote, not inline prose', async () => {
    const withFootnote = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'A claim.' },
        { type: 'footnote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The evidence.' }] }] }
      ]
    })
    const zip = unzipSync(new Uint8Array(await write(withFootnote)))
    const documentXml = strFromU8(zip['word/document.xml']!)
    expect(documentXml).toContain('w:footnoteReference')
    expect(documentXml).toContain('w:id="1"')
    // The note's own text lives in its own part, not spliced into the paragraph.
    expect(documentXml).not.toContain('The evidence.')
    expect(Object.keys(zip)).toContain('word/footnotes.xml')
    expect(strFromU8(zip['word/footnotes.xml']!)).toContain('The evidence.')
  })

  it('numbers footnotes continuously across chapters', async () => {
    const chapterOne = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'One.' },
        { type: 'footnote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First note.' }] }] }
      ]
    })
    const chapterTwo = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Two.' },
        { type: 'footnote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second note.' }] }] }
      ]
    })
    const bytes = await exportDocx({
      documents: [
        { title: 'One', content: chapterOne },
        { title: 'Two', content: chapterTwo }
      ],
      styles: BUILTIN_STYLES,
      page: PAGE
    })
    const zip = unzipSync(new Uint8Array(bytes))
    const documentXml = strFromU8(zip['word/document.xml']!)
    expect(documentXml).toContain('w:id="1"')
    expect(documentXml).toContain('w:id="2"')
    const footnotesXml = strFromU8(zip['word/footnotes.xml']!)
    expect(footnotesXml).toContain('First note.')
    expect(footnotesXml).toContain('Second note.')
  })

  it('names the style rather than copying its formatting', async () => {
    // This is what makes an exported manuscript editable in Word the way it was
    // here: changing Chapter Title there restyles every chapter.
    const xml = await documentXml(doc(para('Chapter One', { styleId: 'chapter-title' })))
    expect(xml).toContain('w:pStyle w:val="Title"')
  })

  it('converts points to twips', async () => {
    const xml = await documentXml(doc(para('x', { spaceBefore: 12, indentLeft: 36 })))
    expect(xml).toContain('w:before="240"')
    expect(xml).toContain('w:left="720"')
  })

  it('writes a negative first line as a hanging indent', async () => {
    // Word has no negative first line, and writing it the other way round
    // produces a paragraph shaped nothing like the original.
    const xml = await documentXml(doc(para('x', { firstLineIndent: -18 })))
    expect(xml).toContain('w:hanging="360"')
    expect(xml).not.toContain('w:firstLine="-360"')
  })

  it('writes the page setup it was given', async () => {
    const xml = await documentXml(doc(para('x')))
    expect(xml).toContain('w:w="12240"')
    expect(xml).toContain('w:h="15840"')
  })

  it('keeps a mention’s text and drops the mark', async () => {
    // The mark carries only a record id; the name is ordinary text. Nothing an
    // author wrote is lost, and name scanning suggests the link back on import.
    const xml = await documentXml(
      doc(para('Harlan waited.', undefined, [{ type: 'mention', attrs: { entityId: 'e1' } }]))
    )
    expect(xml).toContain('Harlan waited.')
    expect(xml).not.toContain('entityId')
    expect(xml).not.toContain('mention')
  })

  it('separates documents with a page break rather than a section break', async () => {
    const buffer = await exportDocx({
      documents: [
        { title: 'One', content: doc(para('First chapter.')) },
        { title: 'Two', content: doc(para('Second chapter.')) }
      ],
      styles: BUILTIN_STYLES,
      page: PAGE
    })
    const xml = strFromU8(unzipSync(new Uint8Array(buffer))['word/document.xml']!)
    expect(xml).toContain('First chapter.')
    expect(xml).toContain('Second chapter.')
    expect(xml).toContain('w:pageBreakBefore')
  })

  it('writes an empty document rather than an invalid one', async () => {
    const zip = unzipSync(new Uint8Array(await write({ type: 'doc', content: [] })))
    expect(strFromU8(zip['word/document.xml']!)).toContain('<w:body>')
  })

  it('emits real Word numbering for a style with numbering configured, not literal text', async () => {
    const styles = BUILTIN_STYLES.map((style) =>
      style.id === 'heading-1'
        ? { ...style, numbering: { format: 'decimal' as const, startAt: 1, levelText: '%1.' } }
        : style
    )
    const zip = unzipSync(
      new Uint8Array(
        await exportDocx({
          documents: [{ title: 'One', content: doc({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] }) }],
          styles,
          page: PAGE
        })
      )
    )
    const numbering = strFromU8(zip['word/numbering.xml']!)
    expect(numbering).toContain('%1.')
    expect(numbering).toContain('decimal')

    const stylesXml = strFromU8(zip['word/styles.xml']!)
    // The heading-1 style itself points at the numbering definition — Word,
    // not The Pub, computes the number an instance of it displays.
    expect(stylesXml).toMatch(/w:numId/)
  })

  it('lets one paragraph opt out of its style’s numbering — a binder heading for front/back matter', async () => {
    const styles = BUILTIN_STYLES.map((style) =>
      style.id === 'heading-1'
        ? { ...style, numbering: { format: 'decimal' as const, startAt: 1, levelText: '%1.' } }
        : style
    )
    const zip = unzipSync(
      new Uint8Array(
        await exportDocx({
          documents: [
            {
              title: 'One',
              content: doc(
                { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
                {
                  type: 'paragraph',
                  attrs: { styleId: 'heading-1', unnumbered: true },
                  content: [{ type: 'text', text: 'Appendix' }]
                }
              )
            }
          ],
          styles,
          page: PAGE
        })
      )
    )
    const body = strFromU8(zip['word/document.xml']!)
    const [chapterPara, appendixPara] = body.split('<w:p>').slice(1)
    // The numbered heading carries no numbering override of its own — Word
    // resolves it from the style. The unnumbered one explicitly cancels it.
    expect(chapterPara).not.toContain('w:numPr')
    expect(appendixPara).toContain('<w:numId w:val="0"/>')
  })
})

describe('round trip', () => {
  /** Everything the editor's schema can hold, in one document. */
  const everything: PmDoc = doc(
    { type: 'heading', attrs: { level: 1, styleId: 'chapter-title' }, content: [{ type: 'text', text: 'Chapter One' }] },
    para('Plain prose.', { styleId: 'body' }),
    para('Justified and spaced.', {
      styleId: 'body',
      textAlign: 'justify',
      spaceBefore: 12,
      spaceAfter: 6,
      lineHeight: 1.5,
      indentLeft: 36,
      indentRight: 18,
      firstLineIndent: 24
    }),
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'struck', marks: [{ type: 'strike' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'under', marks: [{ type: 'underline' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'high', marks: [{ type: 'superscript' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'low', marks: [{ type: 'subscript' }] }
      ]
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Georgia at twelve',
          marks: [{ type: 'textStyle', attrs: { fontFamily: 'Georgia', fontSize: '12pt', color: '#336699' } }]
        }
      ]
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'before ' },
        { type: 'text', text: 'a link', marks: [{ type: 'link', attrs: { href: 'https://example.com/' } }] },
        { type: 'text', text: ' after' }
      ]
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para('first bullet')] },
        { type: 'listItem', content: [para('second bullet')] }
      ]
    },
    {
      type: 'orderedList',
      content: [{ type: 'listItem', content: [para('first number')] }]
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [para('Name')] },
            { type: 'tableHeader', content: [para('Role')] }
          ]
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [para('Harlan')] },
            { type: 'tableCell', content: [para('Keeper')] }
          ]
        }
      ]
    }
  )

  it('survives a trip through Word’s own format', async () => {
    const back = importDocx(new Uint8Array(await write(everything)))
    const blocks = back.content.content!

    expect(blocks[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    expect(text(blocks[0]!)).toBe('Chapter One')
    expect(text(blocks[1]!)).toBe('Plain prose.')

    expect(blocks[2]!.attrs).toMatchObject({
      textAlign: 'justify',
      spaceBefore: 12,
      spaceAfter: 6,
      lineHeight: 1.5,
      indentLeft: 36,
      indentRight: 18,
      firstLineIndent: 24
    })

    const marks = new Set(
      (blocks[3]!.content ?? []).flatMap((node) => (node.marks ?? []).map((mark) => mark.type))
    )
    for (const expected of ['bold', 'italic', 'strike', 'underline', 'superscript', 'subscript']) {
      expect(marks).toContain(expected)
    }

    const styled = blocks[4]!.content![0]!.marks!.find((mark) => mark.type === 'textStyle')!
    expect(styled.attrs).toMatchObject({ fontFamily: 'Georgia', fontSize: '12pt', color: '#336699' })

    expect(text(blocks[5]!)).toBe('before a link after')
    expect(blocks[5]!.content![1]!.marks).toEqual([
      { type: 'link', attrs: { href: 'https://example.com/' } }
    ])

    expect((blocks[6]!.content ?? []).map((node) => node.type)).toEqual([
      'text',
      'hardBreak',
      'text'
    ])

    expect(blocks[7]).toMatchObject({ type: 'bulletList' })
    expect(blocks[7]!.content).toHaveLength(2)
    expect(blocks[8]).toMatchObject({ type: 'orderedList' })

    const table = blocks[9]!
    expect(table.type).toBe('table')
    expect(table.content).toHaveLength(2)
    expect(table.content![0]!.content![0]!.type).toBe('tableHeader')
    expect(text(table.content![1]!)).toBe('HarlanKeeper')
  })

  it('keeps the named styles, so the manuscript stays editable in Word', async () => {
    const back = importDocx(new Uint8Array(await write(everything)))
    const names = back.styles.map((style) => style.name)
    expect(names).toEqual(expect.arrayContaining(['Normal', 'Title']))
    // Only styles the prose refers to come back: a producer writes a dozen
    // definitions nobody used, and importing those would grow the project's
    // style list every time a chapter is imported.
    expect(names).not.toContain('footnote text')
    expect(names).not.toContain('header')
  })

  it('re-resolves those styles onto the project’s own built-ins', async () => {
    // Export then import must not leave a project with a duplicate of every
    // style it started with.
    const back = importDocx(new Uint8Array(await write(everything)))
    const { added } = reconcileStyles(back.styles, BUILTIN_STYLES)
    expect(added).toEqual([])
  })

  it('carries an image out and back', async () => {
    const withImage = doc({
      type: 'paragraph',
      content: [{ type: 'image', attrs: { src: 'pub-asset://asset/whatever' } }]
    })
    const back = importDocx(new Uint8Array(await write(withImage)))
    expect(back.images).toHaveLength(1)
    expect(back.images[0]!.extension).toBe('png')
  })
})

describe('sections: page setup, headers and footers (Phase 7)', () => {
  it('emits a header and a footer when the caller supplies them', async () => {
    const buffer = await exportDocx({
      documents: [{ title: 'One', content: doc(para('Body text.')) }],
      styles: BUILTIN_STYLES,
      page: PAGE,
      header: doc(para('Running Title')),
      footer: doc(para('Confidential Draft'))
    })
    const zip = unzipSync(new Uint8Array(buffer))
    const headerPart = Object.keys(zip).find((name) => /^word\/header\d*\.xml$/.test(name))
    const footerPart = Object.keys(zip).find((name) => /^word\/footer\d*\.xml$/.test(name))
    expect(headerPart).toBeDefined()
    expect(footerPart).toBeDefined()
    expect(strFromU8(zip[headerPart!]!)).toContain('Running Title')
    expect(strFromU8(zip[footerPart!]!)).toContain('Confidential Draft')
  })

  it('writes no header or footer part when the caller supplies neither', async () => {
    const zip = unzipSync(new Uint8Array(await write(doc(para('Body text.')))))
    expect(Object.keys(zip).some((name) => /^word\/(header|footer)\d*\.xml$/.test(name))).toBe(false)
  })

  it('emits landscape orientation when asked, and portrait by default', async () => {
    const landscape = await exportDocx({
      documents: [{ title: 'One', content: doc(para('Wide.')) }],
      styles: BUILTIN_STYLES,
      page: { ...PAGE, orientation: 'landscape' }
    })
    const landscapeXml = strFromU8(unzipSync(new Uint8Array(landscape))['word/document.xml']!)
    expect(landscapeXml).toContain('w:orient="landscape"')

    const portraitXml = strFromU8(unzipSync(new Uint8Array(await write(doc(para('Tall.')))))['word/document.xml']!)
    expect(portraitXml).not.toContain('w:orient="landscape"')
  })
})

describe('the closed world the editor allows', () => {
  it('emits no node or mark type this build cannot render', async () => {
    // The editor is built with `enableContentCheck: true`, and ProseMirror
    // *throws* on an unknown type rather than degrading — so an importer that
    // invents one produces a document that will not open at all. This is what
    // makes that impossible rather than merely unlikely.
    const back = importDocx(new Uint8Array(await write(everythingForSchemaCheck())))
    const nodes = new Set<string>()
    const marks = new Set<string>()
    collectTypes(back.content as unknown as PmNode, nodes, marks)
    expect([...nodes].filter((type) => !EDITOR_NODE_TYPES.has(type))).toEqual([])
    expect([...marks].filter((type) => !EDITOR_MARK_TYPES.has(type))).toEqual([])
  })

  it('emits no inline type the text extractor does not know', async () => {
    // `INLINE_TYPES` in extractText.ts decides what counts as inline; a type
    // missing from it silently shifts word counts, search snippets and every
    // mention offset in the document.
    const { INLINE_TYPES } = await import('../../shared/pm/extractText.js')
    const back = importDocx(new Uint8Array(await write(everythingForSchemaCheck())))
    const inline = new Set<string>()
    for (const block of back.content.content ?? []) collectInline(block, inline)
    expect([...inline].filter((type) => !INLINE_TYPES.has(type))).toEqual([])
  })
})

function everythingForSchemaCheck(): PmDoc {
  return doc(
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
    para('text', undefined, [{ type: 'bold' }]),
    { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'x' } }, { type: 'hardBreak' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'claim' },
        { type: 'footnote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'note' }] }] }
      ]
    },
    { type: 'bulletList', content: [{ type: 'listItem', content: [para('item')] }] },
    {
      type: 'table',
      content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para('cell')] }] }]
    },
    { type: 'horizontalRule' }
  )
}

function collectTypes(node: PmNode, nodes: Set<string>, marks: Set<string>): void {
  nodes.add(node.type)
  for (const mark of node.marks ?? []) marks.add(mark.type)
  for (const child of node.content ?? []) collectTypes(child, nodes, marks)
}

/** Types appearing directly inside a textblock. */
function collectInline(block: PmNode, found: Set<string>): void {
  for (const child of block.content ?? []) {
    if (child.content) collectInline(child, found)
    else found.add(child.type)
  }
}

function text(node: PmNode): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(text).join('')
}
