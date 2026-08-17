import type { NamedStyle, TextStyleAttrs, ParagraphStyleAttrs } from '../../shared/model/style.js'

/**
 * `NamedStyle[]` → a stylesheet, the EPUB counterpart of `styleMap.ts`.
 *
 * Named styles become CSS classes, not inline attributes: a reflowable book
 * that hardcodes a font size is a book nobody can read comfortably at their
 * own text size, which is the whole point of shipping EPUB rather than a
 * fixed page image. Direct (per-run) formatting still becomes inline style —
 * see `xhtml.ts` — the same split `toDocx.ts` makes between a Word style and
 * direct run properties.
 */

/** A style's id, as a CSS class name. Ids are already slug-shaped; this only guards the rare exception. */
export function styleClassName(styleId: string): string {
  return `s-${styleId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

export function buildStylesheet(styles: NamedStyle[]): string {
  const rules = styles.map((style) => {
    const decls = [...textDecls(style.text), ...paragraphDecls(style.paragraph)]
    if (decls.length === 0) return ''
    return `.${styleClassName(style.id)} {\n  ${decls.join('\n  ')}\n}`
  })
  return [BASE_CSS, ...rules.filter((rule) => rule.length > 0)].join('\n\n')
}

function textDecls(text: TextStyleAttrs): string[] {
  const decls: string[] = []
  if (text.fontFamily) decls.push(`font-family: ${text.fontFamily};`)
  if (text.fontSize !== undefined) decls.push(`font-size: ${text.fontSize}pt;`)
  if (text.bold) decls.push('font-weight: bold;')
  if (text.italic) decls.push('font-style: italic;')
  if (text.underline) decls.push('text-decoration: underline;')
  if (text.color) decls.push(`color: ${text.color};`)
  if (text.backgroundColor) decls.push(`background-color: ${text.backgroundColor};`)
  if (text.letterSpacing !== undefined) decls.push(`letter-spacing: ${text.letterSpacing}pt;`)
  if (text.textTransform) decls.push(`text-transform: ${text.textTransform};`)
  return decls
}

function paragraphDecls(paragraph: ParagraphStyleAttrs): string[] {
  const decls: string[] = []
  if (paragraph.align) decls.push(`text-align: ${paragraph.align === 'justify' ? 'justify' : paragraph.align};`)
  if (paragraph.spaceBefore !== undefined) decls.push(`margin-top: ${paragraph.spaceBefore}pt;`)
  if (paragraph.spaceAfter !== undefined) decls.push(`margin-bottom: ${paragraph.spaceAfter}pt;`)
  if (paragraph.lineHeight !== undefined) decls.push(`line-height: ${paragraph.lineHeight};`)
  if (paragraph.indentLeft !== undefined) decls.push(`margin-left: ${paragraph.indentLeft}pt;`)
  if (paragraph.indentRight !== undefined) decls.push(`margin-right: ${paragraph.indentRight}pt;`)
  if (paragraph.firstLineIndent !== undefined) decls.push(`text-indent: ${paragraph.firstLineIndent}pt;`)
  return decls
}

/** Baseline rules every generated XHTML file needs, independent of any named style. */
const BASE_CSS = `body { margin: 0; padding: 1em; }
img { max-width: 100%; }
aside[epub|type~="footnote"] { display: none; }
a.footnote-ref { vertical-align: super; font-size: 0.75em; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid; padding: 0.25em; }`
