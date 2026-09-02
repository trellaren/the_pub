import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  InsertedTextRun,
  DeletedTextRun,
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
  Header,
  Footer,
  PageOrientation,
  type IParagraphOptions,
  type IRunStylePropertiesOptions,
  type IParagraphStylePropertiesOptions,
  type IParagraphStyleOptions,
  type ILevelsOptions,
  type ParagraphChild,
  type FileChild
} from 'docx'
import type { PmDoc, PmNode, PmMark } from '../../shared/model/document.js'
import { pageMargins } from '../../shared/model/document.js'
import type { NamedStyle, Numbering, TextStyleAttrs } from '../../shared/model/style.js'
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
 * Title" there restyles every chapter, exactly as it does in Quoth.
 */

export interface ExportDocument {
  title: string
  content: PmDoc
}

export interface ExportOptions {
  documents: ExportDocument[]
  styles: NamedStyle[]
  page: {
    width: number
    height: number
    margin: number
    margins?: { top: number; bottom: number; left: number; right: number }
    orientation?: 'portrait' | 'landscape'
  }
  /** From the first document's first section (Phase 7), when it has one. */
  header?: PmDoc
  footer?: PmDoc
  /**
   * Author id to display name, for tracked changes. Word has no concept of our
   * ids, so a name is what travels; an id with no entry exports as itself
   * rather than as an empty author, which Word renders as "Unknown" and which
   * loses the only thing that would let the importer pair it up again.
   */
  authors?: Record<string, string>
  /** Resolve an image `src` to bytes. Absent images are skipped, not fatal. */
  readImage?: (src: string) => { data: Uint8Array; type: 'png' | 'jpg' | 'gif' | 'bmp' } | null
  /**
   * BCP-47 language for the whole export (the document's own `lang`, or the
   * project's `publication.language`), written as the file's default run
   * language so Word spell-checks against it. A `lang` mark on a passage
   * overrides this locally, the same way direct formatting overrides a style.
   */
  lang?: string
}

const BULLET_REFERENCE = 'pub-bullet'
const NUMBER_REFERENCE = 'pub-number'
const HEADING_NUMBERING_REFERENCE = 'pub-heading-number'

/**
 * Ids and bodies collected while walking the manuscript, threaded through the
 * block/inline builders below rather than stored on `ExportOptions` — that type
 * is the caller-facing input, and this is mutable output accumulated as a side
 * effect of the walk.
 *
 * Both counters are shared across every document in the export: Word footnote
 * ids and revision ids must each be unique across the whole file, and chapters
 * are exported as one continuous document (see the page-break comment below),
 * so they number continuously too.
 */
interface WalkState {
  next: number
  entries: Record<string, { children: Paragraph[] }>
  nextRevision: number
}

export async function exportDocx(options: ExportOptions): Promise<Buffer> {
  const state: WalkState = { next: 1, entries: {}, nextRevision: 1 }
  const children: FileChild[] = []
  options.documents.forEach((document, index) => {
    // Chapters are separated by a page break rather than a section break: one
    // continuous document is what a manuscript is, and what an agent expects.
    if (index > 0) children.push(new Paragraph({ children: [], pageBreakBefore: true }))
    children.push(...blocksToDocx(document.content.content ?? [], options, state))
  })

  const headingLevels = headingNumberingLevels(options.styles)
  const orientation = options.page.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT
  const margins = pageMargins(options.page)
  const header = options.header ? new Header({ children: headerFooterChildren(options.header, options, state) }) : undefined
  const footer = options.footer ? new Footer({ children: headerFooterChildren(options.footer, options, state) }) : undefined
  const file = new Document({
    title: options.documents[0]?.title,
    styles: {
      ...(options.lang ? { default: { document: { run: { language: { value: options.lang } } } } } : {}),
      paragraphStyles: options.styles.map((style) => styleToDocx(style, options.styles))
    },
    numbering: {
      config: [
        ...numberingConfig(),
        ...(headingLevels ? [{ reference: HEADING_NUMBERING_REFERENCE, levels: headingLevels }] : [])
      ]
    },
    footnotes: state.entries,
    sections: [
      {
        ...(header ? { headers: { default: header } } : {}),
        ...(footer ? { footers: { default: footer } } : {}),
        properties: {
          page: {
            size: {
              width: pointsToTwips(options.page.width),
              height: pointsToTwips(options.page.height),
              orientation
            },
            margin: {
              top: pointsToTwips(margins.top),
              right: pointsToTwips(margins.right),
              bottom: pointsToTwips(margins.bottom),
              left: pointsToTwips(margins.left)
            }
          }
        },
        children: children.length > 0 ? children : [new Paragraph({})]
      }
    ]
  })

  return Packer.toBuffer(file)
}

/** A header or footer's content, built from the same block walker the body uses. */
function headerFooterChildren(doc: PmDoc, options: ExportOptions, state: WalkState): Paragraph[] {
  return blocksToDocx(doc.content ?? [], options, state).filter(
    (child): child is Paragraph => child instanceof Paragraph
  )
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
    paragraph: paragraphProperties(style)
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

function paragraphProperties(style: NamedStyle): IParagraphStylePropertiesOptions {
  const paragraph = style.paragraph
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
  const headingLevel = style.headingLevel
  if (headingLevel !== undefined) properties.outlineLevel = headingLevel - 1
  // Word owns the actual numbers once a paragraph points at a numbering
  // definition — this is what makes inserting a heading above renumber
  // everything below it inside Word itself, not just on Quoth's screen.
  const numberedLevel = style.outlineLevel ?? style.headingLevel
  if (style.numbering && numberedLevel !== undefined) {
    properties.numbering = { reference: HEADING_NUMBERING_REFERENCE, level: numberedLevel - 1 }
  }
  return properties as IParagraphStylePropertiesOptions
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
  justify: AlignmentType.JUSTIFIED,
  // Logical alignments, used by RTL paragraphs so `start`/`end` follow
  // reading direction rather than a fixed physical side.
  start: AlignmentType.START,
  end: AlignmentType.END
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

const NUMBERING_FORMATS: Record<Numbering['format'], (typeof LevelFormat)[keyof typeof LevelFormat]> = {
  decimal: LevelFormat.DECIMAL,
  'upper-roman': LevelFormat.UPPER_ROMAN,
  'lower-roman': LevelFormat.LOWER_ROMAN,
  'upper-alpha': LevelFormat.UPPER_LETTER,
  'lower-alpha': LevelFormat.LOWER_LETTER
}

/**
 * One numbering definition covering outline levels 1-6, built from whichever
 * style declares each level's `numbering` — a level with nothing configured
 * still gets a default entry, so the definition stays valid even though no
 * paragraph ever points at that level. `null` when no style numbers
 * anything, so an ordinary project's export carries no unused numbering part.
 */
function headingNumberingLevels(styles: NamedStyle[]): ILevelsOptions[] | null {
  const byLevel = new Map<number, Numbering>()
  for (const style of styles) {
    const level = style.outlineLevel ?? style.headingLevel
    if (level !== undefined && style.numbering) byLevel.set(level, style.numbering)
  }
  if (byLevel.size === 0) return null
  return Array.from({ length: 6 }, (_unused, index) => {
    const level = index + 1
    const numbering = byLevel.get(level)
    return {
      level: index,
      format: NUMBERING_FORMATS[numbering?.format ?? 'decimal'],
      text: numbering?.levelText ?? `%${level}.`,
      start: numbering?.startAt ?? 1
    }
  })
}

/* ----------------------------------------------------------------- blocks */

function blocksToDocx(nodes: PmNode[], options: ExportOptions, state: WalkState): FileChild[] {
  const children: FileChild[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        children.push(paragraphToDocx(node, options, state))
        break
      case 'blockquote':
        for (const inner of node.content ?? []) {
          children.push(paragraphToDocx(inner, options, state, { style: 'Quote' }))
        }
        break
      case 'bulletList':
      case 'orderedList':
        children.push(...listToDocx(node, options, state, 0))
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
        const table = tableToDocx(node, options, state)
        if (table) children.push(table)
        break
      }
      case 'image':
        children.push(new Paragraph({ children: inlineToDocx([node], options, state) }))
        break
      default:
        // An unknown block still carries prose; losing its shape beats losing
        // the words inside it.
        if (node.content) children.push(...blocksToDocx(node.content, options, state))
        break
    }
  }
  return children
}

function paragraphToDocx(
  node: PmNode,
  options: ExportOptions,
  state: WalkState,
  overrides: Partial<IParagraphOptions> = {}
): Paragraph {
  const attrs = node.attrs ?? {}
  const styleId = typeof attrs.styleId === 'string' ? attrs.styleId : null
  const style = styleId ? options.styles.find((candidate) => candidate.id === styleId) : undefined
  const level = typeof attrs.level === 'number' ? attrs.level : undefined

  const direct: Record<string, unknown> = {}
  const align = typeof attrs.textAlign === 'string' ? attrs.textAlign : null
  if (align && align in ALIGNMENTS) direct.alignment = ALIGNMENTS[align as keyof typeof ALIGNMENTS]
  // `w:bidi` is what makes Word render and edit the paragraph right-to-left;
  // without it a `start`/`end` alignment is ambiguous and Word falls back to
  // treating the paragraph as LTR regardless of the text it contains.
  if (attrs.dir === 'rtl') direct.bidirectional = true

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

  // Set only by `docxService.ts`'s synthetic part-heading documents (never by
  // real prose): suppresses a numbered style's own Word numbering for this one
  // paragraph, so a binder heading for front/back matter never reads "Chapter
  // N" even when the body's chapter style numbers itself.
  if (attrs.unnumbered === true) direct.numbering = false

  return new Paragraph({
    ...(style ? { style: wordStyleFor(style.id, style.name).id } : {}),
    // A heading with no style of its own still has to be a heading in Word, or
    // the navigation pane and any table of contents come out empty.
    ...(!style && level !== undefined && level >= 1 && level <= 6
      ? { heading: HEADINGS[level - 1] }
      : {}),
    ...direct,
    ...overrides,
    children: inlineToDocx(node.content ?? [], options, state)
  })
}

function listToDocx(list: PmNode, options: ExportOptions, state: WalkState, level: number): FileChild[] {
  const reference = list.type === 'orderedList' ? NUMBER_REFERENCE : BULLET_REFERENCE
  const children: FileChild[] = []
  for (const item of list.content ?? []) {
    for (const block of item.content ?? []) {
      if (block.type === 'bulletList' || block.type === 'orderedList') {
        children.push(...listToDocx(block, options, state, Math.min(level + 1, 4)))
        continue
      }
      children.push(
        paragraphToDocx(block, options, state, { numbering: { reference, level: Math.min(level, 4) } })
      )
    }
  }
  return children
}

function tableToDocx(table: PmNode, options: ExportOptions, state: WalkState): Table | null {
  const rows: TableRow[] = []
  for (const row of table.content ?? []) {
    const cells: TableCell[] = []
    for (const cell of row.content ?? []) {
      const content = blocksToDocx(cell.content ?? [], options, state)
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

/**
 * One suggested run, as Word records it.
 *
 * The author is a *name*, because that is the only thing Word has: it has no
 * concept of our author ids, so the registry is consulted here and the name is
 * what travels. Coming back the other way, `fromDocx` matches the name into the
 * registry and mints an id if it has never seen it.
 */
function trackedRun(
  mark: { type: string; attrs?: Record<string, unknown> },
  properties: { text: string },
  options: ExportOptions,
  state: WalkState
): ParagraphChild {
  const authorId = String(mark.attrs?.authorId ?? '')
  const change = {
    id: state.nextRevision++,
    author: options.authors?.[authorId] ?? authorId,
    date: String(mark.attrs?.at || new Date().toISOString())
  }
  return mark.type === 'insertion'
    ? new InsertedTextRun({ ...properties, ...change })
    : new DeletedTextRun({ ...properties, ...change })
}

function inlineToDocx(nodes: PmNode[], options: ExportOptions, state: WalkState): ParagraphChild[] {
  const children: ParagraphChild[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        const link = node.marks?.find((mark) => mark.type === 'link')
        // A suggested edit becomes Word's own tracked change, not a coloured
        // run that looks like one: the payoff of this whole phase is that a
        // reviewer without Quoth sees these in Word's review pane and can
        // accept them there.
        const suggestion = node.marks?.find(
          (mark) => mark.type === 'insertion' || mark.type === 'deletion'
        )
        const properties = { text: node.text ?? '', ...markProperties(node.marks) }
        const run = suggestion
          ? trackedRun(suggestion, properties, options, state)
          : new TextRun(properties)
        const href = link?.attrs?.href
        children.push(
          typeof href === 'string' && href.length > 0 && run instanceof TextRun
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
        const id = state.next++
        const body = blocksToDocx(node.content ?? [], options, state).filter(
          (child): child is Paragraph => child instanceof Paragraph
        )
        state.entries[String(id)] = { children: body.length > 0 ? body : [new Paragraph({})] }
        children.push(new FootnoteReferenceRun(id))
        break
      }
      default:
        if (node.content) children.push(...inlineToDocx(node.content, options, state))
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
      case 'lang': {
        const lang = stringAttr(mark.attrs?.lang)
        if (lang) properties.language = { value: lang }
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
  'mention',
  // Suggested edits round-trip as Word's own tracked changes; see `runsFor`.
  'insertion',
  'deletion',
  'lang'
])
