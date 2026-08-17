import type { PmDoc, PmMark, PmNode } from '../../shared/model/document.js'
import type { NamedStyle } from '../../shared/model/style.js'
import { styleClassName } from './css.js'

/**
 * ProseMirror JSON → XHTML, the EPUB counterpart of `toDocx.ts`'s run
 * builder. One document in, one XHTML `<body>` fragment out (plus the
 * footnotes collected while walking it) — `toEpub.ts` wraps the fragment in
 * the file shell.
 */

export interface XhtmlResult {
  /** Serialized children of `<body>`. */
  body: string
  /** Footnote id → its body XHTML, in the order encountered. */
  footnotes: { id: string; body: string }[]
  /** `src` values referenced by `<img>`, so the caller can copy exactly what's used. */
  imageSrcs: string[]
}

interface WalkState {
  footnotes: { id: string; body: string }[]
  imageSrcs: string[]
  nextFootnote: number
}

export function documentToXhtml(doc: PmDoc, styles: NamedStyle[], footnoteIdPrefix: string): XhtmlResult {
  const state: WalkState = { footnotes: [], imageSrcs: [], nextFootnote: 1 }
  const body = blocksToXhtml(doc.content ?? [], styles, state, footnoteIdPrefix)
  return { body, footnotes: state.footnotes, imageSrcs: state.imageSrcs }
}

function styleClassFor(node: PmNode, styles: NamedStyle[]): string | null {
  const styleId = typeof node.attrs?.styleId === 'string' ? node.attrs.styleId : null
  if (!styleId) return null
  const style = styles.find((candidate) => candidate.id === styleId)
  return style ? styleClassName(style.id) : null
}

function blocksToXhtml(nodes: PmNode[], styles: NamedStyle[], state: WalkState, prefix: string): string {
  return nodes.map((node) => blockToXhtml(node, styles, state, prefix)).join('\n')
}

function blockToXhtml(node: PmNode, styles: NamedStyle[], state: WalkState, prefix: string): string {
  const cls = styleClassFor(node, styles)
  const classAttr = cls ? ` class="${cls}"` : ''
  switch (node.type) {
    case 'paragraph':
      return `<p${classAttr}>${inlineToXhtml(node.content ?? [], state, prefix)}</p>`
    case 'heading': {
      const level = Math.min(Math.max(numberAttr(node.attrs?.level) ?? 1, 1), 6)
      return `<h${level}${classAttr}>${inlineToXhtml(node.content ?? [], state, prefix)}</h${level}>`
    }
    case 'blockquote':
      return `<blockquote${classAttr}>\n${blocksToXhtml(node.content ?? [], styles, state, prefix)}\n</blockquote>`
    case 'bulletList':
      return `<ul${classAttr}>\n${listItemsToXhtml(node.content ?? [], styles, state, prefix)}\n</ul>`
    case 'orderedList':
      return `<ol${classAttr}>\n${listItemsToXhtml(node.content ?? [], styles, state, prefix)}\n</ol>`
    case 'codeBlock':
      return `<pre><code>${escapeXml(plainText(node))}</code></pre>`
    case 'horizontalRule':
      return '<hr/>'
    case 'table':
      return `<table${classAttr}>\n${(node.content ?? []).map((row) => rowToXhtml(row, styles, state, prefix)).join('\n')}\n</table>`
    case 'image':
      return `<p>${inlineToXhtml([node], state, prefix)}</p>`
    default:
      // An unknown block still carries prose; losing its shape beats losing
      // the words inside it, the same trade `toDocx.ts` makes.
      return node.content ? blocksToXhtml(node.content, styles, state, prefix) : ''
  }
}

function listItemsToXhtml(items: PmNode[], styles: NamedStyle[], state: WalkState, prefix: string): string {
  return items
    .map((item) => `<li>\n${blocksToXhtml(item.content ?? [], styles, state, prefix)}\n</li>`)
    .join('\n')
}

function rowToXhtml(row: PmNode, styles: NamedStyle[], state: WalkState, prefix: string): string {
  const isHeader = (row.content ?? []).every((cell) => cell.type === 'tableHeader')
  const cells = (row.content ?? [])
    .map((cell) => {
      const tag = isHeader || cell.type === 'tableHeader' ? 'th' : 'td'
      const span = numberAttr(cell.attrs?.colspan)
      const rowspan = numberAttr(cell.attrs?.rowspan)
      const attrs = `${span && span > 1 ? ` colspan="${span}"` : ''}${rowspan && rowspan > 1 ? ` rowspan="${rowspan}"` : ''}`
      return `<${tag}${attrs}>${blocksToXhtml(cell.content ?? [], styles, state, prefix)}</${tag}>`
    })
    .join('')
  return `<tr>${cells}</tr>`
}

function inlineToXhtml(nodes: PmNode[], state: WalkState, prefix: string): string {
  return nodes.map((node) => inlineNodeToXhtml(node, state, prefix)).join('')
}

function inlineNodeToXhtml(node: PmNode, state: WalkState, prefix: string): string {
  switch (node.type) {
    case 'text':
      return wrapMarks(escapeXml(node.text ?? ''), node.marks)
    case 'hardBreak':
      return '<br/>'
    case 'image': {
      const src = stringAttr(node.attrs?.src)
      if (!src) return ''
      state.imageSrcs.push(src)
      const alt = stringAttr(node.attrs?.alt) ?? ''
      return `<img src="${escapeXml(imageHref(src))}" alt="${escapeXml(alt)}"/>`
    }
    case 'footnote': {
      const id = `${prefix}fn${state.nextFootnote++}`
      const bodyXhtml = blocksToXhtml(node.content ?? [], [], state, prefix)
      const backlink = `<a href="#${id}-ref" class="footnote-backlink">↩</a>`
      state.footnotes.push({
        id,
        body: `<aside epub:type="footnote" id="${id}">\n${bodyXhtml}\n${backlink}\n</aside>`
      })
      return `<a id="${id}-ref" href="#${id}" epub:type="noteref" class="footnote-ref">*</a>`
    }
    case 'field':
      // No special case, the same as `toDocx.ts`: a field exports as its text child.
      return inlineToXhtml(node.content ?? [], state, prefix)
    default:
      return node.content ? inlineToXhtml(node.content, state, prefix) : ''
  }
}

/**
 * Marks a run carries.
 *
 * `mention` is deliberately absent, mirroring `toDocx.ts`'s `markProperties`:
 * it holds only a record id, and the name underneath is ordinary text, which
 * is what exports. `insertion`/`deletion` (Phase 9 suggested edits) have no
 * EPUB counterpart — a reflowable book has no reviewer — so they export as
 * plain text; the suggestion itself does not travel, same as a reader
 * opening a `.docx` with tracked changes turned off.
 */
function wrapMarks(text: string, marks: PmMark[] | undefined): string {
  let html = text
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
        html = `<strong>${html}</strong>`
        break
      case 'italic':
        html = `<em>${html}</em>`
        break
      case 'underline':
        html = `<span style="text-decoration:underline">${html}</span>`
        break
      case 'strike':
        html = `<s>${html}</s>`
        break
      case 'superscript':
        html = `<sup>${html}</sup>`
        break
      case 'subscript':
        html = `<sub>${html}</sub>`
        break
      case 'code':
        html = `<code>${html}</code>`
        break
      case 'highlight': {
        const color = stringAttr(mark.attrs?.color)
        html = `<mark${color ? ` style="background-color:${escapeXml(color)}"` : ''}>${html}</mark>`
        break
      }
      case 'textStyle': {
        const decls: string[] = []
        const font = stringAttr(mark.attrs?.fontFamily)
        const size = stringAttr(mark.attrs?.fontSize)
        const color = stringAttr(mark.attrs?.color)
        const background = stringAttr(mark.attrs?.backgroundColor)
        if (font) decls.push(`font-family:${font}`)
        if (size) decls.push(`font-size:${size}`)
        if (color) decls.push(`color:${color}`)
        if (background) decls.push(`background-color:${background}`)
        html = decls.length > 0 ? `<span style="${escapeXml(decls.join(';'))}">${html}</span>` : html
        break
      }
      case 'link': {
        const href = stringAttr(mark.attrs?.href)
        if (href) html = `<a href="${escapeXml(href)}">${html}</a>`
        break
      }
      // 'mention', 'insertion', 'deletion': see doc comment above.
      default:
        break
    }
  }
  return html
}

/** Rewritten relative to the XHTML file's own location inside the EPUB — see `toEpub.ts`'s layout. */
export function imageHref(src: string): string {
  const name = src.split('/').pop() ?? src
  return `../images/${name}`
}

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

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Every node and mark type the XHTML writer handles, mirrored from
 * `toDocx.ts`'s `EDITOR_NODE_TYPES`/`EDITOR_MARK_TYPES`. The closed-world
 * test in `toEpub.test.ts` asserts this set equals the editor's, so a node
 * or mark type added to the schema and forgotten here fails a test instead
 * of vanishing silently from every exported ebook.
 */
export const XHTML_NODE_TYPES = new Set([
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

export const XHTML_MARK_TYPES = new Set([
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
  'insertion',
  'deletion'
])
