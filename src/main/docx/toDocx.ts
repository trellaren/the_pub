import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  ExternalHyperlink,
  FootnoteReferenceRun,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  HeadingLevel,
  LineRuleType,
  LevelFormat,
  UnderlineType,
  WidthType,
  type IParagraphOptions,
  type IRunStylePropertiesOptions,
  type ILevelParagraphStylePropertiesOptions,
  type IParagraphStyleOptions,
  type ILevelsOptions,
  type ParagraphChild,
  type FileChild
} from 'docx'
import type { PmDoc, PmNode, PmMark } from '../../shared/model/document.js'
import type { NamedStyle, ParagraphStyleAttrs, TextStyleAttrs } from '../../shared/model/style.js'
import {
  pointsToTwips,
  pointsToHalfPoints,
  lineHeightToUnits,
  cssColorToOoxml,
  parsePointLength
} from './units.js'
import { wordStyleFor } from './styleMap.js'

/**
 * Writing a `.docx`.
 *
 * Built on the `docx` library rather than by hand. The single largest risk in
 * this direction is emitting a file Word refuses to open, and there is no Word
 * on the machine that builds this to check against — so the mitigation is to
 * use a producer that is already proven against it, and spend the effort on the
 * mapping instead.
 *
 * The named styles go into the file's own style part, which is what makes an
 * exported manuscript editable in Word the way it was here: changing "Chapter
 * Title" there restyles every chapter, exactly as it does in The Pub.
 */

export interface ExportDocument {
  title: string
  content: PmDoc
}

export interface ExportOptions {
  documents: ExportDocument[]
  styles: NamedStyle[]
  page: { width: number; height: number; margin: number }
  /** Resolve an image `src` to bytes. Absent images are skipped, not fatal. */
  readImage?: (src: string) => { data: Uint8Array; type: 'png' | 'jpg' | 'gif' | 'bmp' } | null
}

const BULLET_REFERENCE = 'pub-bullet'
const NUMBER_REFERENCE = 'pub-number'

/**
 * Footnote ids and bodies collected while walking the manuscript, threaded
 * through the block/inline builders below rather than stored on
 * `ExportOptions` — that type is the caller-facing input, and this is
 * mutable output accumulated as a side effect of the walk.
 *
 * Ids are shared across every document in the export: Word footnote ids must
 * be unique across the whole file, and chapters are exported as one
 * continuous document (see the page-break comment below), so their footnotes
 * number continuously too.
 */
interface FootnoteState {
  next: number
  entries: Record<string, { children: Paragraph[] }>
}

export async function exportDocx(options: ExportOptions): Promise<Buffer> {
  const footnotes: FootnoteState = { next: 1, entries: {} }
  const children: FileChild[] = []
  options.documents.forEach((document, index) => {
    // Chapters are separated by a page break rather than a section break: one
    // continuous document is what a manuscript is, and what an agent expects.
    if (index > 0) children.push(new Paragraph({ children: [], pageBreakBefore: true }))
    children.push(...blocksToDocx(document.content.content ?? [], options, footnotes))
  })

  const file = new Document({
    title: options.documents[0]?.title,
    styles: { paragraphStyles: options.styles.map((style) => styleToDocx(style, options.styles)) },
    numbering: { config: numberingConfig() },
    footnotes: footnotes.entries,
    sections: [
      {
        properties: {
          page: {
            size: {
              width: pointsToTwips(options.page.width),
              height: pointsToTwips(options.page.height)
            },
            margin: {
              top: pointsToTwips(options.page.margin),
              right: pointsToTwips(options.page.margin),
              bottom: pointsToTwips(options.page.margin),
              left: pointsToTwips(options.page.margin)
            }
          }
        },
        children: children.length > 0 ? children : [new Paragraph({})]
      }
    ]
  })

  return Packer.toBuffer(file)
}

/* ----------------------------------------------------------------- styles */

function styleToDocx(style: NamedStyle, all: NamedStyle[]): IParagraphStyleOptions {
  const word = wordStyleFor(style.id, style.name)
  const basedOn = style.basedOn ? all.find((candidate) => candidate.id === style.basedOn) : undefined
  const next = style.nextStyle ? all.find((candidate) => candidate.id === style.nextStyle) : undefined
  // Word resolves inheritance itself, so the style is written with only what it
  // sets — the same relationship `resolveStyle` models here.
  return {
    id: word.id,
    name: word.name,
    basedOn: basedOn ? wordStyleFor(basedOn.id, basedOn.name).id : undefined,
    next: next ? wordStyleFor(next.id, next.name).id : undefined,
    quickFormat: true,
    run: runProperties(style.text),
    paragraph: paragraphProperties(style.paragraph, style.headingLevel)
  }
}

function runProperties(text: TextStyleAttrs): IRunStylePropertiesOptions {
  const properties: Record<string, unknown> = {}
  if (text.fontFamily) properties.font = primaryFont(text.fontFamily)
  if (text.fontSize !== undefined) properties.size = pointsToHalfPoints(text.fontSize)
  if (text.bold !== undefined) properties.bold = text.bold
  if (text.italic !== undefined) properties.italics = text.italic
  if (text.underline) properties.underline = { type: UnderlineType.SINGLE }
  const color = cssColorToOoxml(text.color)
  if (color) properties.color = color
  const shading = cssColorToOoxml(text.backgroundColor)
  if (shading) properties.shading = { fill: shading }
  if (text.letterSpacing !== undefined) {
    // `w:spacing` on a run is in twentieths of a point, like everything else
    // Word measures; the style model stores points.
    properties.characterSpacing = pointsToTwips(text.letterSpacing)
  }
  if (text.textTransform === 'uppercase') properties.allCaps = true
  return properties as IRunStylePropertiesOptions
}

function paragraphProperties(
  paragraph: ParagraphStyleAttrs,
  headingLevel?: number
): ILevelParagraphStylePropertiesOptions {
  const properties: Record<string, unknown> = {}
  if (paragraph.align) properties.alignment = ALIGNMENTS[paragraph.align]

  const spacing: Record<string, unknown> = {}
  if (paragraph.spaceBefore !== undefined) spacing.before = pointsToTwips(paragraph.spaceBefore)
  if (paragraph.spaceAfter !== undefined) spacing.after = pointsToTwips(paragraph.spaceAfter)
  if (paragraph.lineHeight !== undefined) {
    spacing.line = lineHeightToUnits(paragraph.lineHeight)
    spacing.lineRule = LineRuleType.AUTO
  }
  if (Object.keys(spacing).length > 0) properties.spacing = spacing

  const indent = indentProperties(paragraph)
  if (indent) properties.indent = indent
  if (paragraph.keepWithNext) properties.keepNext = true
  // A heading's outline level is what makes it appear in Word's navigation pane
  // and in a generated table of contents.
  if (headingLevel !== undefined) properties.outlineLevel = headingLevel - 1
  return properties as ILevelParagraphStylePropertiesOptions
}

function indentProperties(paragraph: {
  indentLeft?: number
  indentRight?: number
  firstLineIndent?: number
}): Record<string, number> | null {
  const indent: Record<string, number> = {}
  if (paragraph.indentLeft !== undefined) indent.left = pointsToTwips(paragraph.indentLeft)
  if (paragraph.indentRight !== undefined) indent.right = pointsToTwips(paragraph.indentRight)
  if (paragraph.firstLineIndent !== undefined) {
    // Word has no negative first line: that is a hanging indent, and writing it
    // the other way round produces a paragraph shaped nothing like the original.
    if (paragraph.firstLineIndent < 0) indent.hanging = pointsToTwips(-paragraph.firstLineIndent)
    else if (paragraph.firstLineIndent > 0) indent.firstLine = pointsToTwips(paragraph.firstLineIndent)
  }
  return Object.keys(indent).length > 0 ? indent : null
}

const ALIGNMENTS = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED
} as const

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
] as const

/** CSS font stacks list fallbacks; Word wants one name. */
function primaryFont(stack: string): string {
  return stack.split(',')[0]!.trim().replace(/^["']|["']$/g, '')
}

/**
 * Five levels of bullets and numbers, defined up front.
 *
 * A `.docx` cannot express a list inline: the numbering definitions live in
 * their own part and paragraphs point at them. Defining both whether or not the
 * manuscript has lists costs a few hundred bytes and removes a whole class of
 * "the list came out unnumbered" bug.
 */
function numberingConfig(): { reference: string; levels: ILevelsOptions[] }[] {
  const levels = (
    format: (typeof LevelFormat)[keyof typeof LevelFormat],
    text: (level: number) => string
  ): ILevelsOptions[] =>
    Array.from({ length: 5 }, (_unused, level) => ({
      level,
      format,
      text: text(level),
      alignment: AlignmentType.LEFT,
      style: {
        paragraph: {
          indent: { left: pointsToTwips(24 * (level + 1)), hanging: pointsToTwips(18) }
        }
      }
    }))
  return [
    { reference: BULLET_REFERENCE, levels: levels(LevelFormat.BULLET, () => '•') },
    { reference: NUMBER_REFERENCE, levels: levels(LevelFormat.DECIMAL, (level) => `%${level + 1}.`) }
  ]
}

/* ----------------------------------------------------------------- blocks */

function blocksToDocx(nodes: PmNode[], options: ExportOptions, footnotes: FootnoteState): FileChild[] {
  const children: FileChild[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        children.push(paragraphToDocx(node, options, footnotes))
        break
      case 'blockquote':
        for (const inner of node.content ?? []) {
          children.push(paragraphToDocx(inner, options, footnotes, { style: 'Quote' }))
        }
        break
      case 'bulletList':
      case 'orderedList':
        children.push(...listToDocx(node, options, footnotes, 0))
        break
      case 'codeBlock':
        children.push(
          new Paragraph({
            children: [new TextRun({ text: plainText(node), font: 'Courier New' })]
          })
        )
        break
      case 'horizontalRule':
        children.push(new Paragraph({ thematicBreak: true }))
        break
      case 'table': {
        const table = tableToDocx(node, options, footnotes)
        if (table) children.push(table)
        break
      }
      case 'image':
        children.push(new Paragraph({ children: inlineToDocx([node], options, footnotes) }))
        break
      default:
        // An unknown block still carries prose; losing its shape beats losing
        // the words inside it.
        if (node.content) children.push(...blocksToDocx(node.content, options, footnotes))
        break
    }
  }
  return children
}

function paragraphToDocx(
  node: PmNode,
  options: ExportOptions,
  footnotes: FootnoteState,
  overrides: Partial<IParagraphOptions> = {}
): Paragraph {
  const attrs = node.attrs ?? {}
  const styleId = typeof attrs.styleId === 'string' ? attrs.styleId : null
  const style = styleId ? options.styles.find((candidate) => candidate.id === styleId) : undefined
  const level = typeof attrs.level === 'number' ? attrs.level : undefined

  const direct: Record<string, unknown> = {}
  const align = typeof attrs.textAlign === 'string' ? attrs.textAlign : null
  if (align && align in ALIGNMENTS) direct.alignment = ALIGNMENTS[align as keyof typeof ALIGNMENTS]

  const spacing: Record<string, unknown> = {}
  const before = numberAttr(attrs.spaceBefore)
  const after = numberAttr(attrs.spaceAfter)
  const lineHeight = numberAttr(attrs.lineHeight)
  if (before !== null) spacing.before = pointsToTwips(before)
  if (after !== null) spacing.after = pointsToTwips(after)
  if (lineHeight !== null) {
    spacing.line = lineHeightToUnits(lineHeight)
    spacing.lineRule = LineRuleType.AUTO
  }
  if (Object.keys(spacing).length > 0) direct.spacing = spacing

  const indent = indentProperties({
    indentLeft: numberAttr(attrs.indentLeft) ?? undefined,
    indentRight: numberAttr(attrs.indentRight) ?? undefined,
    firstLineIndent: numberAttr(attrs.firstLineIndent) ?? undefined
  })
  if (indent) direct.indent = indent

  return new Paragraph({
    ...(style ? { style: wordStyleFor(style.id, style.name).id } : {}),
    // A heading with no style of its own still has to be a heading in Word, or
    // the navigation pane and any table of contents come out empty.
    ...(!style && level !== undefined && level >= 1 && level <= 6
      ? { heading: HEADINGS[level - 1] }
      : {}),
    ...direct,
    ...overrides,
    children: inlineToDocx(node.content ?? [], options, footnotes)
  })
}

function listToDocx(list: PmNode, options: ExportOptions, footnotes: FootnoteState, level: number): FileChild[] {
  const reference = list.type === 'orderedList' ? NUMBER_REFERENCE : BULLET_REFERENCE
  const children: FileChild[] = []
  for (const item of list.content ?? []) {
    for (const block of item.content ?? []) {
      if (block.type === 'bulletList' || block.type === 'orderedList') {
        children.push(...listToDocx(block, options, footnotes, Math.min(level + 1, 4)))
        continue
      }
      children.push(
        paragraphToDocx(block, options, footnotes, { numbering: { reference, level: Math.min(level, 4) } })
      )
    }
  }
  return children
}

function tableToDocx(table: PmNode, options: ExportOptions, footnotes: FootnoteState): Table | null {
  const rows: TableRow[] = []
  for (const row of table.content ?? []) {
    const cells: TableCell[] = []
    for (const cell of row.content ?? []) {
      const content = blocksToDocx(cell.content ?? [], options, footnotes)
      cells.push(
        new TableCell({
          columnSpan: numberAttr(cell.attrs?.colspan) ?? undefined,
          rowSpan: numberAttr(cell.attrs?.rowspan) ?? undefined,
          children: content.length > 0 ? content : [new Paragraph({})]
        })
      )
    }
    if (cells.length > 0) rows.push(new TableRow({ children: cells, tableHeader: isHeaderRow(row) }))
  }
  if (rows.length === 0) return null
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })
}

function isHeaderRow(row: PmNode): boolean {
  return (row.content ?? []).every((cell) => cell.type === 'tableHeader')
}

/* ----------------------------------------------------------------- inline */

function inlineToDocx(nodes: PmNode[], options: ExportOptions, footnotes: FootnoteState): ParagraphChild[] {
  const children: ParagraphChild[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        const link = node.marks?.find((mark) => mark.type === 'link')
        const run = new TextRun({ text: node.text ?? '', ...markProperties(node.marks) })
        const href = link?.attrs?.href
        children.push(
          typeof href === 'string' && href.length > 0
            ? new ExternalHyperlink({ children: [run], link: href })
            : run
        )
        break
      }
      case 'hardBreak':
        children.push(new TextRun({ break: 1 }))
        break
      case 'image': {
        const image = imageRun(node, options)
        if (image) children.push(image)
        break
      }
      case 'footnote': {
        const id = footnotes.next++
        const body = blocksToDocx(node.content ?? [], options, footnotes).filter(
          (child): child is Paragraph => child instanceof Paragraph
        )
        footnotes.entries[String(id)] = { children: body.length > 0 ? body : [new Paragraph({})] }
        children.push(new FootnoteReferenceRun(id))
        break
      }
      default:
        if (node.content) children.push(...inlineToDocx(node.content, options, footnotes))
        break
    }
  }
  return children
}

/**
 * Marks a run carries.
 *
 * The `mention` mark is deliberately absent. It holds only a record id, and the
 * name underneath it is ordinary text — which is the property the mark was
 * designed around. A re-imported document loses the links, but name scanning
 * suggests them straight back, so nothing an author wrote is destroyed.
 */
function markProperties(marks: PmMark[] | undefined): IRunStylePropertiesOptions {
  const properties: Record<string, unknown> = {}
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
        properties.bold = true
        break
      case 'italic':
        properties.italics = true
        break
      case 'underline':
        properties.underline = { type: UnderlineType.SINGLE }
        break
      case 'strike':
        properties.strike = true
        break
      case 'superscript':
        properties.superScript = true
        break
      case 'subscript':
        properties.subScript = true
        break
      case 'code':
        properties.font = 'Courier New'
        break
      case 'highlight': {
        const color = cssColorToOoxml(stringAttr(mark.attrs?.color))
        // `w:highlight` only accepts Word's sixteen named colours, so an
        // arbitrary highlight is written as shading, which takes any colour.
        if (color) properties.shading = { fill: color }
        break
      }
      case 'textStyle': {
        const font = stringAttr(mark.attrs?.fontFamily)
        if (font) properties.font = primaryFont(font)
        const size = parsePointLength(mark.attrs?.fontSize)
        if (size !== null) properties.size = pointsToHalfPoints(size)
        const color = cssColorToOoxml(stringAttr(mark.attrs?.color))
        if (color) properties.color = color
        const background = cssColorToOoxml(stringAttr(mark.attrs?.backgroundColor))
        if (background) properties.shading = { fill: background }
        break
      }
      default:
        break
    }
  }
  return properties as IRunStylePropertiesOptions
}

function imageRun(node: PmNode, options: ExportOptions): ImageRun | null {
  const src = stringAttr(node.attrs?.src)
  if (!src || !options.readImage) return null
  const image = options.readImage(src)
  if (!image) return null
  return new ImageRun({
    type: image.type,
    data: image.data,
    // The document carries no intrinsic size, and a wrong one is worse than a
    // conservative one an author can drag.
    transformation: { width: 400, height: 300 }
  })
}

/* ----------------------------------------------------------------- shared */

function plainText(node: PmNode): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(plainText).join('')
}

function numberAttr(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Every node and mark type an exported document can contain.
 *
 * Mirrored from `createEditor.ts`. The editor is built with
 * `enableContentCheck: true`, and ProseMirror *throws* on an unknown type
 * rather than degrading — so a document containing a type this build cannot
 * render does not open at all. The importer is tested against this list, which
 * turns "the importer must not invent node types" from a rule someone has to
 * remember into one the suite enforces.
 */
export const EDITOR_NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'heading',
  'text',
  'hardBreak',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'horizontalRule',
  'image',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'field',
  'footnote'
])

export const EDITOR_MARK_TYPES = new Set([
  'bold',
  'italic',
  'strike',
  'code',
  'underline',
  'link',
  'textStyle',
  'highlight',
  'subscript',
  'superscript',
  'mention'
])
