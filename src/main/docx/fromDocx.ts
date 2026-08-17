import { unzipSync, strFromU8 } from 'fflate'
import type { PmDoc, PmNode, PmMark } from '../../shared/model/document.js'
import type { NamedStyle, TextStyleAttrs, ParagraphStyleAttrs } from '../../shared/model/style.js'
import {
  toggleValue,
  twipsToPoints,
  halfPointsToPoints,
  unitsToLineHeight,
  ooxmlColorToCss,
  formatPointLength
} from './units.js'
import {
  parseXml,
  root,
  nameOf,
  childrenOf,
  childrenNamed,
  child,
  path,
  hasChild,
  att,
  numAtt,
  textIn,
  type XmlNode
} from './xml.js'
import { builtinForWordStyle } from './styleMap.js'
import { importedAuthorId, type AuthorProfile } from '../../shared/model/author.js'
import { INSERTION_MARK, DELETION_MARK } from '../../shared/model/suggestion.js'

/**
 * Reading a `.docx`.
 *
 * This parses `word/document.xml` directly rather than going through a
 * converter like mammoth, which turns a document into HTML and drops most of
 * what this app is for — named styles, indents, spacing, alignment. For an
 * editor that claims Word-grade formatting, throwing that away at the door is
 * the wrong trade.
 *
 * Everything that cannot be represented is *reported*, never dropped in
 * silence: `warnings` is what the import summary shows the author, so a lost
 * footnote is a sentence they can read rather than a discovery months later.
 */

export interface ImportedImage {
  /** Zip entry name, e.g. `word/media/image1.png`. */
  part: string
  extension: string
  data: Uint8Array
}

export interface DocxImport {
  content: PmDoc
  /** Styles the document defined, still carrying Word ids. Reconciled by the caller. */
  styles: NamedStyle[]
  images: ImportedImage[]
  /**
   * Authors discovered in tracked changes, to be merged into the project's
   * registry by the caller — this module knows nothing about a project, so it
   * reports them rather than writing them.
   */
  authors: AuthorProfile[]
  warnings: string[]
  /** Page setup, reported to the author but never applied project-wide. */
  page: { width: number; height: number; margin: number } | null
}

/**
 * An image's `src` until the caller has written the bytes into the project.
 * `Image` is configured `allowBase64: false`, and only the caller knows where
 * the project's assets live, so the placeholder is rewritten there.
 */
export const IMAGE_PLACEHOLDER_PREFIX = 'docx-media:'

const DOCUMENT_PART = 'word/document.xml'
const STYLES_PART = 'word/styles.xml'
const NUMBERING_PART = 'word/numbering.xml'
const RELS_PART = 'word/_rels/document.xml.rels'
const FOOTNOTES_PART = 'word/footnotes.xml'

/**
 * Features with no representation here. Each is named in a warning rather than
 * quietly discarded — an author who exported from Word with footnotes deserves
 * to know they did not survive the trip.
 *
 * Footnotes themselves are no longer in this list — they import as real
 * `footnote` nodes, below. Word's *endnotes* (a distinct OOXML part from
 * footnotes, `word/endnotes.xml`) are a separate, still-unsupported feature —
 * not to be confused with this app's own "endnotes region", which is a
 * rendering choice for footnote content, not an import target of its own.
 */
const UNSUPPORTED: { tag: string; label: string }[] = [
  { tag: 'w:endnoteReference', label: 'Endnotes' },
  { tag: 'w:commentReference', label: 'Comments' },
  { tag: 'w:sdt>', label: 'Content controls' },
  { tag: 'w:object', label: 'Embedded objects' },
  { tag: 'w:txbxContent', label: 'Text boxes' },
  { tag: 'w:headerReference', label: 'Headers and footers' }
]

export function importDocx(bytes: Uint8Array): DocxImport {
  const zip = unzipSync(bytes)
  const documentXml = zip[DOCUMENT_PART]
  if (!documentXml) {
    throw new Error('This is not a Word document: it has no word/document.xml part.')
  }

  const source = strFromU8(documentXml)
  const context: Context = {
    relations: readRelations(zip[RELS_PART]),
    numbering: readNumbering(zip[NUMBERING_PART]),
    styleById: new Map(),
    footnotesById: new Map(),
    warnings: [],
    seen: new Set(),
    used: new Set(),
    authors: new Map()
  }

  const { styles, byId } = readStyles(zip[STYLES_PART])
  context.styleById = byId
  // Read before the body, which is what needs the lookup this populates.
  readFootnotes(zip[FOOTNOTES_PART], context)

  const body = path(root(parseXml(source), 'w:document'), ['w:body'])
  if (!body) throw new Error('This Word document has no body.')

  const content = readBlocks(body, context)
  noteUnsupported(source, context)

  return {
    content: { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] },
    styles: usedStyles(styles, context.used),
    images: collectImages(zip),
    authors: [...context.authors.values()],
    warnings: context.warnings,
    page: readSectionSetup(body)
  }
}

/**
 * Only the styles the prose actually refers to.
 *
 * Every producer writes a pile of definitions nobody used — footnote text,
 * endnote text, header, footer, table grid. Importing those would add a dozen
 * styles to the author's project that they never asked for and cannot tell
 * apart from their own, every time they import a chapter. A style nothing
 * refers to has no effect on how the document looks, so dropping it loses
 * nothing.
 *
 * `basedOn` ancestors come too: an unused parent still supplies the formatting
 * its children inherit.
 */
function usedStyles(styles: NamedStyle[], used: Set<string>): NamedStyle[] {
  const byId = new Map(styles.map((style) => [style.id, style]))
  const keep = new Set<string>()
  const visit = (id: string): void => {
    if (keep.has(id)) return
    const style = byId.get(id)
    if (!style) return
    keep.add(id)
    if (style.basedOn) visit(style.basedOn)
  }
  for (const id of used) visit(id)
  return styles.filter((style) => keep.has(style.id))
}

interface Context {
  relations: Map<string, string>
  numbering: Map<string, 'bullet' | 'ordered'>
  styleById: Map<string, { name: string; headingLevel?: number }>
  /** A footnote's Word id to its already-parsed content, read from `word/footnotes.xml`. */
  footnotesById: Map<string, PmNode[]>
  warnings: string[]
  seen: Set<string>
  /** Style ids a paragraph actually referred to. */
  used: Set<string>
  /** Word author name to the id minted for them. */
  authors: Map<string, AuthorProfile>
}

function warn(context: Context, message: string): void {
  // One line per kind of loss, however many times it happened: forty identical
  // warnings is a summary nobody reads.
  if (context.seen.has(message)) return
  context.seen.add(message)
  context.warnings.push(message)
}

function noteUnsupported(xml: string, context: Context): void {
  for (const { tag, label } of UNSUPPORTED) {
    if (xml.includes(`<${tag}`)) warn(context, `${label} were not imported.`)
  }
}

/* ------------------------------------------------------------------ parts */

function readRelations(part: Uint8Array | undefined): Map<string, string> {
  const relations = new Map<string, string>()
  if (!part) return relations
  const relationships = root(parseXml(strFromU8(part)), 'Relationships')
  for (const relation of childrenNamed(relationships, 'Relationship')) {
    const id = att(relation, 'Id')
    const target = att(relation, 'Target')
    if (id && target) relations.set(id, target)
  }
  return relations
}

/**
 * Which numbering definitions are bullets and which are numbers.
 *
 * A paragraph's `w:numPr` names a `w:numId`, which points at an
 * `w:abstractNum`, which holds the actual format. Two hops — and skipping them
 * means guessing, which is how every imported numbered list comes back bulleted.
 */
function readNumbering(part: Uint8Array | undefined): Map<string, 'bullet' | 'ordered'> {
  const kinds = new Map<string, 'bullet' | 'ordered'>()
  if (!part) return kinds
  const numbering = root(parseXml(strFromU8(part)), 'w:numbering')
  if (!numbering) return kinds

  const abstractKind = new Map<string, 'bullet' | 'ordered'>()
  for (const abstract of childrenNamed(numbering, 'w:abstractNum')) {
    const id = att(abstract, 'w:abstractNumId')
    if (!id) continue
    // Level zero decides: a bulleted list with a numbered sub-level is still a
    // bulleted list as far as this editor's schema is concerned.
    const level =
      childrenNamed(abstract, 'w:lvl').find((entry) => att(entry, 'w:ilvl') === '0') ??
      child(abstract, 'w:lvl')
    const format = att(child(level, 'w:numFmt'), 'w:val')
    abstractKind.set(id, format === 'bullet' || format === 'none' ? 'bullet' : 'ordered')
  }

  for (const num of childrenNamed(numbering, 'w:num')) {
    const numId = att(num, 'w:numId')
    if (!numId) continue
    const abstractId = att(child(num, 'w:abstractNumId'), 'w:val')
    kinds.set(numId, (abstractId ? abstractKind.get(abstractId) : undefined) ?? 'bullet')
  }
  return kinds
}

/**
 * A footnote's body lives in its own part, addressed by an id every
 * `w:footnoteReference` in the body carries — the reverse of how this app
 * models it, where the content sits directly inside the reference's own node.
 * Reading the whole part up front, before the body, is what lets a single
 * `w:footnoteReference` become a fully-populated `footnote` node in one step.
 *
 * `w:type="separator"` and `"continuationSeparator"` entries are Word's own
 * page-layout furniture (the rule drawn above footnotes that continue onto a
 * following page) — not an author's footnote, and skipped accordingly.
 */
function readFootnotes(part: Uint8Array | undefined, context: Context): void {
  if (!part) return
  const container = root(parseXml(strFromU8(part)), 'w:footnotes')
  for (const footnote of childrenNamed(container, 'w:footnote')) {
    const type = att(footnote, 'w:type')
    if (type === 'separator' || type === 'continuationSeparator') continue
    const id = att(footnote, 'w:id')
    if (!id) continue
    context.footnotesById.set(id, readBlocks(footnote, context))
  }
}

function readStyles(part: Uint8Array | undefined): {
  styles: NamedStyle[]
  byId: Map<string, { name: string; headingLevel?: number }>
} {
  const styles: NamedStyle[] = []
  const byId = new Map<string, { name: string; headingLevel?: number }>()
  if (!part) return { styles, byId }

  const container = root(parseXml(strFromU8(part)), 'w:styles')
  for (const style of childrenNamed(container, 'w:style')) {
    if (att(style, 'w:type') !== 'paragraph') continue
    const id = att(style, 'w:styleId')
    if (!id) continue
    const name = att(child(style, 'w:name'), 'w:val') ?? id
    const headingLevel = headingLevelFor(style, name)
    byId.set(id, { name, headingLevel })
    styles.push({
      id,
      name,
      builtin: false,
      basedOn: att(child(style, 'w:basedOn'), 'w:val'),
      nextStyle: att(child(style, 'w:next'), 'w:val'),
      headingLevel,
      text: readRunStyle(child(style, 'w:rPr')),
      paragraph: readParagraphStyle(child(style, 'w:pPr'))
    })
  }
  return { styles, byId }
}

function headingLevelFor(style: XmlNode, name: string): number | undefined {
  const outline = numAtt(path(style, ['w:pPr', 'w:outlineLvl']), 'w:val')
  if (outline !== null && outline >= 0 && outline <= 5) return outline + 1
  const builtin = builtinForWordStyle(name) ?? builtinForWordStyle(att(style, 'w:styleId') ?? '')
  const match = builtin ? /^heading-([1-6])$/.exec(builtin) : null
  return match ? Number(match[1]) : undefined
}

function collectImages(zip: Record<string, Uint8Array>): ImportedImage[] {
  const images: ImportedImage[] = []
  for (const [part, data] of Object.entries(zip)) {
    if (!part.startsWith('word/media/')) continue
    // A zip carries directory entries as well as files, and `word/media/` is
    // one of them — an empty entry that is not an image.
    if (part.endsWith('/') || data.length === 0) continue
    const dot = part.lastIndexOf('.')
    if (dot <= part.lastIndexOf('/')) continue
    images.push({ part, extension: part.slice(dot + 1).toLowerCase(), data })
  }
  return images
}

/* ----------------------------------------------------------------- blocks */

function readBlocks(container: XmlNode, context: Context): PmNode[] {
  const nodes: PmNode[] = []
  for (const node of childrenOf(container)) {
    if (nameOf(node) === 'w:p') pushParagraph(nodes, node, context)
    else if (nameOf(node) === 'w:tbl') {
      const table = readTable(node, context)
      if (table) nodes.push(table)
    }
  }
  return nodes
}

function pushParagraph(nodes: PmNode[], paragraph: XmlNode, context: Context): void {
  const properties = child(paragraph, 'w:pPr')
  const numId = att(path(properties, ['w:numPr', 'w:numId']), 'w:val')
  const block = readParagraph(paragraph, context)

  if (numId === undefined) {
    nodes.push(block)
    return
  }

  // Word has no list node: every item is an ordinary paragraph carrying a
  // numbering reference. Consecutive items have to be gathered back into one
  // list, because that is the shape this editor's schema needs.
  const listType = (context.numbering.get(numId) ?? 'bullet') === 'ordered' ? 'orderedList' : 'bulletList'
  const item: PmNode = { type: 'listItem', content: [stripListIndent(block)] }
  const previous = nodes[nodes.length - 1]
  if (previous?.type === listType) {
    previous.content = [...(previous.content ?? []), item]
    return
  }
  nodes.push({ type: listType, content: [item] })
}

/** A list item's paragraph carries the list's own indent; keeping it double-indents. */
function stripListIndent(block: PmNode): PmNode {
  if (!block.attrs) return block
  const { indentLeft: _left, firstLineIndent: _first, ...rest } = block.attrs
  return Object.keys(rest).length > 0 ? { ...block, attrs: rest } : { type: block.type, ...(block.content ? { content: block.content } : {}) }
}

function readParagraph(paragraph: XmlNode, context: Context): PmNode {
  const properties = child(paragraph, 'w:pPr')
  const styleId = att(child(properties, 'w:pStyle'), 'w:val')
  if (styleId) context.used.add(styleId)
  const style = styleId ? context.styleById.get(styleId) : undefined
  const format = readParagraphStyle(properties)

  const attrs: Record<string, unknown> = {}
  if (styleId) attrs.styleId = styleId
  if (format.align) attrs.textAlign = format.align
  if (format.lineHeight !== undefined) attrs.lineHeight = format.lineHeight
  if (format.spaceBefore !== undefined) attrs.spaceBefore = format.spaceBefore
  if (format.spaceAfter !== undefined) attrs.spaceAfter = format.spaceAfter
  if (format.indentLeft !== undefined) attrs.indentLeft = format.indentLeft
  if (format.indentRight !== undefined) attrs.indentRight = format.indentRight
  if (format.firstLineIndent !== undefined) attrs.firstLineIndent = format.firstLineIndent

  const content = readInline(paragraph, context)
  const outline = numAtt(child(properties, 'w:outlineLvl'), 'w:val')
  const level = style?.headingLevel ?? (outline !== null ? outline + 1 : 0)

  if (level >= 1 && level <= 6) {
    return { type: 'heading', attrs: { ...attrs, level }, ...(content.length ? { content } : {}) }
  }
  return {
    type: 'paragraph',
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(content.length ? { content } : {})
  }
}

function readParagraphStyle(properties: XmlNode | undefined): ParagraphStyleAttrs {
  const style: ParagraphStyleAttrs = {}
  if (!properties) return style

  const align = att(child(properties, 'w:jc'), 'w:val')
  if (align === 'left' || align === 'center' || align === 'right' || align === 'justify') {
    style.align = align
  } else if (align === 'both' || align === 'start') {
    // Word's own names for justified and left.
    style.align = align === 'both' ? 'justify' : 'left'
  }

  const spacing = child(properties, 'w:spacing')
  if (spacing) {
    const before = numAtt(spacing, 'w:before')
    const after = numAtt(spacing, 'w:after')
    const line = numAtt(spacing, 'w:line')
    if (before !== null) style.spaceBefore = twipsToPoints(before)
    if (after !== null) style.spaceAfter = twipsToPoints(after)
    // `w:lineRule="exact"` and `"atLeast"` are absolute lengths, and this
    // editor's line height is a multiplier — so only `auto` can convert.
    if (line !== null && (att(spacing, 'w:lineRule') ?? 'auto') === 'auto') {
      style.lineHeight = unitsToLineHeight(line)
    }
  }

  const indent = child(properties, 'w:ind')
  if (indent) {
    const left = numAtt(indent, 'w:left') ?? numAtt(indent, 'w:start')
    const right = numAtt(indent, 'w:right') ?? numAtt(indent, 'w:end')
    const firstLine = numAtt(indent, 'w:firstLine')
    const hanging = numAtt(indent, 'w:hanging')
    if (left !== null) style.indentLeft = twipsToPoints(left)
    if (right !== null) style.indentRight = twipsToPoints(right)
    // A hanging indent is a negative first line, and Word treats the two as
    // mutually exclusive — reading both would double-count.
    if (hanging !== null) style.firstLineIndent = -twipsToPoints(hanging)
    else if (firstLine !== null) style.firstLineIndent = twipsToPoints(firstLine)
  }

  if (toggle(properties, 'w:keepNext')) style.keepWithNext = true
  if (toggle(properties, 'w:pageBreakBefore')) style.pageBreakBefore = true
  return style
}

function readRunStyle(properties: XmlNode | undefined): TextStyleAttrs {
  const style: TextStyleAttrs = {}
  if (!properties) return style
  if (hasChild(properties, 'w:b')) style.bold = toggle(properties, 'w:b')
  if (hasChild(properties, 'w:i')) style.italic = toggle(properties, 'w:i')
  if (hasChild(properties, 'w:u')) {
    style.underline = (att(child(properties, 'w:u'), 'w:val') ?? 'single') !== 'none'
  }
  const size = numAtt(child(properties, 'w:sz'), 'w:val')
  if (size !== null) style.fontSize = halfPointsToPoints(size)
  const font = att(child(properties, 'w:rFonts'), 'w:ascii')
  if (font) style.fontFamily = font
  const color = ooxmlColorToCss(att(child(properties, 'w:color'), 'w:val'))
  if (color) style.color = color
  return style
}

/**
 * Read a toggle property the way OOXML defines it: present means on, but an
 * explicit `w:val="0"` means off. Reading presence alone is the classic
 * importer bug — it turns every deliberately un-bolded run bold.
 */
function toggle(properties: XmlNode | undefined, name: string): boolean {
  const element = child(properties, name)
  if (!element) return false
  return toggleValue(element[':@'] ?? {})
}

/* ----------------------------------------------------------------- inline */

function readInline(container: XmlNode, context: Context, inherited: PmMark[] = []): PmNode[] {
  const nodes: PmNode[] = []
  for (const node of childrenOf(container)) {
    const name = nameOf(node)
    if (name === 'w:r') nodes.push(...readRun(node, context, inherited))
    else if (name === 'w:hyperlink') {
      nodes.push(...readInline(node, context, [...inherited, ...linkMark(node, context)]))
    } else if (name === 'w:ins' || name === 'w:del') {
      // The whole point of the phase in the other direction: Word's own
      // revisions become this app's suggestion marks, so a manuscript marked up
      // in Word arrives with its changes still pending rather than already
      // applied.
      const mark = name === 'w:ins' ? INSERTION_MARK : DELETION_MARK
      nodes.push(...readInline(node, context, [...inherited, suggestionMark(node, mark, context)]))
    }
  }
  return mergeAdjacentText(nodes)
}

/**
 * Word records the author as a display name, having no notion of our ids, so
 * one is minted from the name — see `importedAuthorId` for why that is stable
 * rather than random.
 */
function suggestionMark(revision: XmlNode, type: string, context: Context): PmMark {
  const name = (att(revision, 'w:author') ?? '').trim()
  const id = name ? importedAuthorId(name) : 'docx-anonymous'
  if (!context.authors.has(id)) {
    context.authors.set(id, { id, name: name || 'Unnamed reviewer', color: '' })
  }
  return { type, attrs: { authorId: id, at: att(revision, 'w:date') ?? '' } }
}

function linkMark(hyperlink: XmlNode, context: Context): PmMark[] {
  const id = att(hyperlink, 'r:id')
  const anchor = att(hyperlink, 'w:anchor')
  const href = id ? context.relations.get(id) : anchor ? `#${anchor}` : undefined
  return href ? [{ type: 'link', attrs: { href } }] : []
}

function readRun(run: XmlNode, context: Context, inherited: PmMark[]): PmNode[] {
  const marks = [...inherited, ...runMarks(child(run, 'w:rPr'))]
  const nodes: PmNode[] = []

  for (const node of childrenOf(run)) {
    switch (nameOf(node)) {
      // Inside a `w:del`, Word stores the text as `w:delText`; a reader that
      // only knows `w:t` silently drops every deleted word.
      case 'w:delText':
      case 'w:t': {
        const text = textIn(node)
        if (text.length > 0) nodes.push({ type: 'text', text, ...(marks.length ? { marks } : {}) })
        break
      }
      case 'w:tab':
        // There is no tab node in this schema, so a tab becomes the space it
        // looks like rather than vanishing and joining two words together.
        nodes.push({ type: 'text', text: ' ', ...(marks.length ? { marks } : {}) })
        break
      case 'w:br':
        if (att(node, 'w:type') === 'page') {
          warn(context, 'Manual page breaks were imported as line breaks.')
        }
        nodes.push({ type: 'hardBreak' })
        break
      case 'w:drawing':
      case 'w:pict': {
        const image = readImage(node, context)
        if (image) nodes.push(image)
        break
      }
      case 'w:footnoteReference': {
        const id = att(node, 'w:id')
        const content = id ? context.footnotesById.get(id) : undefined
        if (content) {
          nodes.push({ type: 'footnote', content: content.length > 0 ? content : [{ type: 'paragraph' }] })
        } else {
          warn(context, 'A footnote reference could not be matched to its text and was dropped.')
        }
        break
      }
      default:
        break
    }
  }
  return nodes
}

function runMarks(properties: XmlNode | undefined): PmMark[] {
  const marks: PmMark[] = []
  if (!properties) return marks
  if (toggle(properties, 'w:b')) marks.push({ type: 'bold' })
  if (toggle(properties, 'w:i')) marks.push({ type: 'italic' })
  if (toggle(properties, 'w:strike')) marks.push({ type: 'strike' })
  if (hasChild(properties, 'w:u') && (att(child(properties, 'w:u'), 'w:val') ?? 'single') !== 'none') {
    marks.push({ type: 'underline' })
  }
  const vertical = att(child(properties, 'w:vertAlign'), 'w:val')
  if (vertical === 'superscript') marks.push({ type: 'superscript' })
  if (vertical === 'subscript') marks.push({ type: 'subscript' })

  const highlight =
    highlightColor(att(child(properties, 'w:highlight'), 'w:val')) ??
    ooxmlColorToCss(att(child(properties, 'w:shd'), 'w:fill'))
  if (highlight) marks.push({ type: 'highlight', attrs: { color: highlight } })

  const textStyle: Record<string, unknown> = {}
  const font = att(child(properties, 'w:rFonts'), 'w:ascii')
  if (font) textStyle.fontFamily = font
  const size = numAtt(child(properties, 'w:sz'), 'w:val')
  // The mark stores a CSS length string while a NamedStyle stores a number of
  // points; both are deliberate, and `units.ts` owns the bridge between them.
  if (size !== null) textStyle.fontSize = formatPointLength(halfPointsToPoints(size))
  const color = ooxmlColorToCss(att(child(properties, 'w:color'), 'w:val'))
  if (color) textStyle.color = color
  if (Object.keys(textStyle).length > 0) marks.push({ type: 'textStyle', attrs: textStyle })

  const lang = att(child(properties, 'w:lang'), 'w:val')
  if (lang) marks.push({ type: 'lang', attrs: { lang } })

  return marks
}

/** Word's fixed highlight palette, as CSS. Anything unrecognised is left alone. */
const HIGHLIGHTS: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
  black: '#000000'
}

function highlightColor(value: string | undefined): string | null {
  if (!value || value === 'none') return null
  return HIGHLIGHTS[value] ?? null
}

function readImage(drawing: XmlNode, context: Context): PmNode | null {
  const embed = findAttribute(drawing, 'r:embed') ?? findAttribute(drawing, 'r:id')
  if (!embed) return null
  const target = context.relations.get(embed)
  if (!target) return null
  const cleaned = target.replace(/^\.\.\//, '').replace(/^\//, '')
  const part = cleaned.startsWith('word/') ? cleaned : `word/${cleaned}`
  return { type: 'image', attrs: { src: `${IMAGE_PLACEHOLDER_PREFIX}${part}` } }
}

/** A drawing nests its relationship id several levels down, and the depth varies. */
function findAttribute(node: XmlNode, name: string): string | undefined {
  const direct = att(node, name)
  if (direct !== undefined) return direct
  for (const item of childrenOf(node)) {
    const found = findAttribute(item, name)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Word splits a sentence into runs at every formatting change, and often at
 * spell-check boundaries too. Merging identically-marked neighbours keeps the
 * saved JSON readable and, more to the point, keeps block text a single string
 * — which is what the search index and the mention scanner measure offsets in.
 */
function mergeAdjacentText(nodes: PmNode[]): PmNode[] {
  const merged: PmNode[] = []
  for (const node of nodes) {
    const previous = merged[merged.length - 1]
    if (node.type === 'text' && previous?.type === 'text' && sameMarks(previous.marks, node.marks)) {
      previous.text = `${previous.text ?? ''}${node.text ?? ''}`
      continue
    }
    merged.push({ ...node })
  }
  return merged
}

function sameMarks(left: PmMark[] | undefined, right: PmMark[] | undefined): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
}

/* ------------------------------------------------------------------ table */

function readTable(table: XmlNode, context: Context): PmNode | null {
  const rows: PmNode[] = []
  for (const row of childrenNamed(table, 'w:tr')) {
    const isHeaderRow = hasChild(path(row, ['w:trPr']), 'w:tblHeader')
    const cells: PmNode[] = []
    for (const cell of childrenNamed(row, 'w:tc')) {
      const properties = child(cell, 'w:tcPr')
      const merge = child(properties, 'w:vMerge')
      if (merge && att(merge, 'w:val') !== 'restart') {
        // A continuation cell has no counterpart in this schema; dropping it
        // keeps the row widths honest instead of producing a ragged table.
        warn(context, 'Vertically merged table cells were flattened.')
        continue
      }
      const attrs: Record<string, unknown> = {}
      const span = numAtt(child(properties, 'w:gridSpan'), 'w:val')
      if (span !== null && span > 1) attrs.colspan = span
      const content = readBlocks(cell, context)
      cells.push({
        type: isHeaderRow ? 'tableHeader' : 'tableCell',
        ...(Object.keys(attrs).length ? { attrs } : {}),
        content: content.length > 0 ? content : [{ type: 'paragraph' }]
      })
    }
    if (cells.length > 0) rows.push({ type: 'tableRow', content: cells })
  }
  return rows.length > 0 ? { type: 'table', content: rows } : null
}

/* ------------------------------------------------------------------- page */

function readSectionSetup(body: XmlNode): { width: number; height: number; margin: number } | null {
  const section = child(body, 'w:sectPr')
  if (!section) return null
  const size = child(section, 'w:pgSz')
  const margins = child(section, 'w:pgMar')
  const width = numAtt(size, 'w:w')
  const height = numAtt(size, 'w:h')
  const left = numAtt(margins, 'w:left')
  if (width === null || height === null) return null
  return {
    width: twipsToPoints(width),
    height: twipsToPoints(height),
    margin: left === null ? 72 : twipsToPoints(left)
  }
}
