import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { importDocx, IMAGE_PLACEHOLDER_PREFIX } from './fromDocx.js'
import {
  buildDocx,
  paragraph,
  run,
  footnote,
  WORD_STYLES,
  WORD_NUMBERING,
  TINY_PNG
} from './fixtures.js'
import type { PmNode } from '../../shared/model/document.js'

function blocks(body: string, extra: Parameters<typeof buildDocx>[0] = { body }): PmNode[] {
  return importDocx(buildDocx({ ...extra, body })).content.content ?? []
}

function textOf(node: PmNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(textOf).join('')
}

describe('importDocx', () => {
  it('refuses a file that is not a Word document', () => {
    expect(() => importDocx(buildDocxWithout())).toThrow(/not a Word document/)
  })

  it('reads paragraphs in order', () => {
    const found = blocks(paragraph(run('First.')) + paragraph(run('Second.')))
    expect(found.map(textOf)).toEqual(['First.', 'Second.'])
  })

  it('keeps the spaces between runs', () => {
    // Word writes `<w:t xml:space="preserve"> </w:t>`; a parser that trims
    // values silently joins the words either side of it.
    const found = blocks(paragraph(run('The lighthouse') + run(' ') + run('keeper')))
    expect(textOf(found[0])).toBe('The lighthouse keeper')
  })

  it('merges runs Word split for its own reasons', () => {
    // Word splits at spell-check and revision boundaries, not just formatting
    // ones. Text has to end up as one string or block offsets drift.
    const found = blocks(paragraph(run('Har') + run('lan') + run(' walked.')))
    expect(found[0]!.content).toHaveLength(1)
    expect(textOf(found[0])).toBe('Harlan walked.')
  })
})

describe('run formatting', () => {
  it('reads a bare toggle as on', () => {
    const found = blocks(paragraph(run('bold', '<w:b/>')))
    expect(found[0]!.content![0]!.marks).toEqual([{ type: 'bold' }])
  })

  it('reads an explicit zero as off', () => {
    // The classic importer bug: presence alone would make this bold.
    const found = blocks(paragraph(run('plain', '<w:b w:val="0"/>')))
    expect(found[0]!.content![0]!.marks ?? []).toEqual([])
  })

  it('reads every mark the editor has', () => {
    const found = blocks(
      paragraph(
        run('x', '<w:i/><w:strike/><w:u w:val="single"/><w:vertAlign w:val="superscript"/>')
      )
    )
    const types = (found[0]!.content![0]!.marks ?? []).map((mark) => mark.type)
    expect(types).toEqual(expect.arrayContaining(['italic', 'strike', 'underline', 'superscript']))
  })

  it('treats an underline of "none" as no underline', () => {
    const found = blocks(paragraph(run('x', '<w:u w:val="none"/>')))
    expect(found[0]!.content![0]!.marks ?? []).toEqual([])
  })

  it('converts half-points to the CSS string the mark stores', () => {
    const found = blocks(paragraph(run('x', '<w:sz w:val="24"/>')))
    const textStyle = (found[0]!.content![0]!.marks ?? []).find((mark) => mark.type === 'textStyle')
    expect(textStyle!.attrs).toMatchObject({ fontSize: '12pt' })
  })

  it('reads fonts and colours', () => {
    const found = blocks(
      paragraph(run('x', '<w:rFonts w:ascii="Georgia"/><w:color w:val="FF0000"/>'))
    )
    const textStyle = (found[0]!.content![0]!.marks ?? []).find((mark) => mark.type === 'textStyle')
    expect(textStyle!.attrs).toMatchObject({ fontFamily: 'Georgia', color: '#ff0000' })
  })

  it('reads a highlight from Word’s named palette', () => {
    const found = blocks(paragraph(run('x', '<w:highlight w:val="yellow"/>')))
    const highlight = (found[0]!.content![0]!.marks ?? []).find((mark) => mark.type === 'highlight')
    expect(highlight!.attrs).toEqual({ color: '#ffff00' })
  })

  it('turns a line break into a hard break, and a tab into a space', () => {
    const found = blocks(paragraph('<w:r><w:t>a</w:t><w:br/><w:tab/><w:t>b</w:t></w:r>'))
    expect(found[0]!.content!.map((node) => node.type)).toEqual([
      'text',
      'hardBreak',
      'text'
    ])
    expect(textOf(found[0])).toBe('a b')
  })
})

describe('paragraph formatting', () => {
  it('converts twips to points', () => {
    const found = blocks(
      paragraph(run('x'), '<w:spacing w:before="240" w:after="120"/><w:ind w:left="720" w:right="360"/>')
    )
    expect(found[0]!.attrs).toMatchObject({
      spaceBefore: 12,
      spaceAfter: 6,
      indentLeft: 36,
      indentRight: 18
    })
  })

  it('reads a hanging indent as a negative first line', () => {
    const found = blocks(paragraph(run('x'), '<w:ind w:left="720" w:hanging="360"/>'))
    expect(found[0]!.attrs).toMatchObject({ indentLeft: 36, firstLineIndent: -18 })
  })

  it('reads Word’s spelling of justified', () => {
    expect(blocks(paragraph(run('x'), '<w:jc w:val="both"/>'))[0]!.attrs).toMatchObject({
      textAlign: 'justify'
    })
    expect(blocks(paragraph(run('x'), '<w:jc w:val="center"/>'))[0]!.attrs).toMatchObject({
      textAlign: 'center'
    })
  })

  it('converts automatic line spacing and declines the absolute kind', () => {
    expect(blocks(paragraph(run('x'), '<w:spacing w:line="360" w:lineRule="auto"/>'))[0]!.attrs)
      .toMatchObject({ lineHeight: 1.5 })
    // `exact` is a length, not a multiple, and this editor only has a
    // multiplier — guessing one would be worse than leaving it unset.
    expect(
      blocks(paragraph(run('x'), '<w:spacing w:line="360" w:lineRule="exact"/>'))[0]!.attrs
        ?.lineHeight
    ).toBeUndefined()
  })
})

describe('styles', () => {
  it('carries the document’s styles out for the caller to reconcile', () => {
    const result = importDocx(
      buildDocx({ body: paragraph(run('x'), '<w:pStyle w:val="Epigraph"/>'), styles: WORD_STYLES })
    )
    const epigraph = result.styles.find((style) => style.id === 'Epigraph')!
    expect(epigraph.name).toBe('Epigraph')
    expect(epigraph.basedOn).toBe('Normal')
    expect(epigraph.text).toMatchObject({ italic: true, fontSize: 10 })
    expect(epigraph.paragraph).toMatchObject({ indentLeft: 36, indentRight: 36, align: 'justify' })
  })

  it('turns a style with an outline level into a heading node', () => {
    const found = blocks(paragraph(run('Chapter One'), '<w:pStyle w:val="Heading1"/>'), {
      body: '',
      styles: WORD_STYLES
    })
    expect(found[0]!.type).toBe('heading')
    expect(found[0]!.attrs).toMatchObject({ level: 1, styleId: 'Heading1' })
  })

  it('reads an outline level set on the paragraph itself', () => {
    const found = blocks(paragraph(run('A heading'), '<w:outlineLvl w:val="1"/>'))
    expect(found[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
  })
})

describe('lists', () => {
  const body =
    paragraph(run('one'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') +
    paragraph(run('two'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') +
    paragraph(run('first'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>')

  it('gathers consecutive items back into one list', () => {
    // Word has no list node: every item is a paragraph carrying a numbering
    // reference, so the list itself has to be reconstructed.
    const found = blocks(body, { body: '', numbering: WORD_NUMBERING })
    expect(found.map((node) => node.type)).toEqual(['bulletList', 'orderedList'])
    expect(found[0]!.content).toHaveLength(2)
    expect(textOf(found[0])).toBe('onetwo')
  })

  it('follows numId → abstractNum to tell a number from a bullet', () => {
    // Skipping either hop is how every imported numbered list comes back
    // bulleted.
    const found = blocks(body, { body: '', numbering: WORD_NUMBERING })
    expect(found[1]!.type).toBe('orderedList')
  })

  it('drops the indent Word puts on each item, which the list supplies itself', () => {
    const found = blocks(
      paragraph(
        run('one'),
        '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:left="720"/>'
      ),
      { body: '', numbering: WORD_NUMBERING }
    )
    const item = found[0]!.content![0]!.content![0]!
    expect(item.attrs?.indentLeft).toBeUndefined()
  })
})

describe('links, images and tables', () => {
  it('reads a hyperlink through the relationship part', () => {
    const found = blocks(
      `<w:p><w:hyperlink r:id="rId9">${run('the archive')}</w:hyperlink></w:p>`,
      {
        body: '',
        relationships:
          '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/archive"/>'
      }
    )
    expect(found[0]!.content![0]!.marks).toEqual([
      { type: 'link', attrs: { href: 'https://example.com/archive' } }
    ])
  })

  it('keeps a hyperlink in its place among the runs around it', () => {
    // The parser groups children by tag name unless asked not to, which would
    // move this link to the end of the paragraph.
    const found = blocks(
      `<w:p>${run('before ')}<w:hyperlink r:id="rId9">${run('link')}</w:hyperlink>${run(' after')}</w:p>`,
      {
        body: '',
        relationships: '<Relationship Id="rId9" Type="hyperlink" Target="https://example.com"/>'
      }
    )
    expect(textOf(found[0])).toBe('before link after')
    expect(found[0]!.content![1]!.marks![0]!.type).toBe('link')
  })

  it('keeps a table in its place among the paragraphs around it', () => {
    const table = `<w:tbl><w:tr><w:tc>${paragraph(run('cell'))}</w:tc></w:tr></w:tbl>`
    const found = blocks(paragraph(run('before')) + table + paragraph(run('after')))
    expect(found.map((node) => node.type)).toEqual(['paragraph', 'table', 'paragraph'])
  })

  it('reads a header row and a column span', () => {
    const found = blocks(
      '<w:tbl>' +
        `<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${paragraph(run('head'))}</w:tc></w:tr>` +
        `<w:tr><w:tc>${paragraph(run('a'))}</w:tc><w:tc>${paragraph(run('b'))}</w:tc></w:tr>` +
        '</w:tbl>'
    )
    const rows = found[0]!.content!
    expect(rows[0]!.content![0]!.type).toBe('tableHeader')
    expect(rows[0]!.content![0]!.attrs).toMatchObject({ colspan: 2 })
    expect(rows[1]!.content![0]!.type).toBe('tableCell')
  })

  it('points an image at its media part for the caller to write', () => {
    const found = blocks(
      `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
      {
        body: '',
        relationships: '<Relationship Id="rId5" Type="image" Target="media/image1.png"/>',
        media: { 'word/media/image1.png': TINY_PNG }
      }
    )
    expect(found[0]!.content![0]).toMatchObject({
      type: 'image',
      attrs: { src: `${IMAGE_PLACEHOLDER_PREFIX}word/media/image1.png` }
    })
  })

  it('hands the image bytes over rather than embedding them', () => {
    // `Image` is configured allowBase64: false, and only the caller knows where
    // the project's assets live.
    const result = importDocx(
      buildDocx({ body: paragraph(run('x')), media: { 'word/media/image1.png': TINY_PNG } })
    )
    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toMatchObject({ part: 'word/media/image1.png', extension: 'png' })
  })
})

describe('footnotes', () => {
  it('reads a footnote reference into a footnote node carrying its text', () => {
    const found = blocks(paragraph(`${run('A claim.')}<w:r><w:footnoteReference w:id="2"/></w:r>`), {
      body: '',
      footnotes: footnote('2', paragraph(run('The evidence.')))
    })
    const note = found[0]!.content!.find((node) => node.type === 'footnote')
    expect(note).toBeDefined()
    expect(textOf(note)).toBe('The evidence.')
  })

  it('skips separator and continuation-separator entries, not just real footnotes', () => {
    const found = blocks(paragraph(`${run('x')}<w:r><w:footnoteReference w:id="1"/></w:r>`), {
      body: '',
      footnotes:
        '<w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote>' +
        '<w:footnote w:type="continuationSeparator" w:id="0"><w:p/></w:footnote>' +
        footnote('1', paragraph(run('Real note.')))
    })
    const note = found[0]!.content!.find((node) => node.type === 'footnote')
    expect(textOf(note)).toBe('Real note.')
  })

  it('carries a multi-paragraph footnote body through as multiple paragraphs', () => {
    const found = blocks(paragraph(`${run('x')}<w:r><w:footnoteReference w:id="1"/></w:r>`), {
      body: '',
      footnotes: footnote('1', paragraph(run('First.')) + paragraph(run('Second.')))
    })
    const note = found[0]!.content!.find((node) => node.type === 'footnote')
    expect(note!.content!.map((block) => textOf(block))).toEqual(['First.', 'Second.'])
  })

  it('no longer reports footnotes as unsupported once they are matched', () => {
    const result = importDocx(
      buildDocx({
        body: paragraph(`${run('x')}<w:r><w:footnoteReference w:id="1"/></w:r>`),
        footnotes: footnote('1', paragraph(run('Note.')))
      })
    )
    expect(result.warnings).toEqual([])
  })
})

describe('what could not be imported', () => {
  it('names each kind of loss once', () => {
    // No `footnotes` part is given, so both references are dangling — the
    // successful case (a real footnotes part) is covered under 'footnotes' below.
    const result = importDocx(
      buildDocx({
        body:
          paragraph(`${run('a')}<w:r><w:footnoteReference w:id="1"/></w:r>`) +
          paragraph(`${run('b')}<w:r><w:footnoteReference w:id="2"/></w:r>`)
      })
    )
    // Forty identical warnings is a summary nobody reads.
    expect(result.warnings).toEqual(['A footnote reference could not be matched to its text and was dropped.'])
  })

  it('says so rather than dropping tracked changes in silence', () => {
    const result = importDocx(
      buildDocx({ body: `<w:p><w:ins w:id="1" w:author="x">${run('added')}</w:ins></w:p>` })
    )
    expect(result.warnings).toContain('Tracked insertions were not imported.')
    // The text itself still arrives — losing the revision is not losing the prose.
    expect(textOf(result.content.content![0])).toBe('added')
  })
})

describe('page setup', () => {
  it('reports it without applying it', () => {
    const result = importDocx(
      buildDocx({
        body:
          paragraph(run('x')) +
          '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:left="1440" w:right="1440"/></w:sectPr>'
      })
    )
    // A4, in points, rounded.
    expect(result.page).toEqual({ width: 595.3, height: 841.9, margin: 72 })
  })

  it('is null when the document says nothing about pages', () => {
    expect(importDocx(buildDocx({ body: paragraph(run('x')) })).page).toBeNull()
  })
})

/** A valid zip archive that is not a Word document. */
function buildDocxWithout(): Uint8Array {
  return zipSync({ 'hello.txt': strToU8('not a document') })
}
