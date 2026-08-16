import { Extension } from '@tiptap/core'
import type { CSSProperties } from 'react'
import type { NamedStyle } from '@shared/model/style.js'
import { resolveStyle } from '@shared/model/style.js'

export interface NamedStylesOptions {
  /** Read live from the project manifest so style edits apply without rebuilding the editor. */
  getStyles: () => NamedStyle[]
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    namedStyles: {
      /** Apply a project style to the selected blocks, switching node type if the style is a heading. */
      setNamedStyle: (styleId: string) => ReturnType
    }
  }
}

/**
 * Word-style named styles.
 *
 * A block stores only the id of the style it uses; all the actual formatting
 * lives in the project manifest and is rendered through a generated stylesheet.
 * That is what lets "make Heading 1 bigger" restyle an entire manuscript
 * instantly instead of rewriting every document.
 */
export const NamedStyles = Extension.create<NamedStylesOptions>({
  name: 'namedStyles',

  addOptions() {
    return { getStyles: () => [] }
  },

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          styleId: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-style'),
            renderHTML: (attributes) => {
              if (!attributes.styleId) return {}
              return {
                'data-style': attributes.styleId,
                class: `pub-style-${attributes.styleId}`
              }
            }
          }
        }
      }
    ]
  },

  addCommands() {
    return {
      setNamedStyle:
        (styleId: string) =>
        ({ commands }) => {
          const style = this.options.getStyles().find((candidate) => candidate.id === styleId)
          if (!style) return false
          return style.headingLevel
            ? commands.setNode('heading', { level: style.headingLevel, styleId })
            : commands.setNode('paragraph', { styleId })
        }
    }
  },

  addKeyboardShortcuts() {
    return {
      // Word's "style for following paragraph": pressing Enter at the end of a
      // Chapter Title should start a body paragraph, not another title.
      Enter: () => {
        const { state } = this.editor
        const { $from, empty } = state.selection
        if (!empty) return false
        const styleId = $from.parent.attrs.styleId as string | undefined
        if (!styleId) return false
        if ($from.parentOffset !== $from.parent.content.size) return false
        const style = this.options.getStyles().find((candidate) => candidate.id === styleId)
        const next = style?.nextStyle
        if (!next || next === styleId) return false
        return this.editor.chain().splitBlock().setNamedStyle(next).run()
      },
      /**
       * A screenplay's "this line could *instead* be a Character line" — a
       * different relationship from Enter's "what comes next", so it walks a
       * separate ring (`cycleStyle`) rather than reusing `nextStyle`. One hop
       * per press, same as Enter: `cycleRing`'s bounded multi-hop walk exists
       * for validating a ring, not for what a single keypress does.
       */
      Tab: () => {
        const { state } = this.editor
        const { $from, empty } = state.selection
        if (!empty) return false
        const styleId = $from.parent.attrs.styleId as string | undefined
        if (!styleId) return false
        const style = this.options.getStyles().find((candidate) => candidate.id === styleId)
        const next = style?.cycleStyle
        if (!next || next === styleId) return false
        return this.editor.chain().setNamedStyle(next).run()
      }
    }
  }
})

function declarations(style: NamedStyle, all: NamedStyle[]): Record<string, string> {
  const resolved = resolveStyle(style.id, all)
  if (!resolved) return {}
  const { text, paragraph } = resolved
  const css: Record<string, string> = {}

  if (text.fontFamily) css['font-family'] = text.fontFamily
  if (text.fontSize !== undefined) css['font-size'] = `${text.fontSize}pt`
  if (text.bold !== undefined) css['font-weight'] = text.bold ? '700' : '400'
  if (text.italic !== undefined) css['font-style'] = text.italic ? 'italic' : 'normal'
  if (text.underline) css['text-decoration'] = 'underline'
  if (text.color) css['color'] = text.color
  if (text.backgroundColor) css['background-color'] = text.backgroundColor
  if (text.letterSpacing !== undefined) css['letter-spacing'] = `${text.letterSpacing / 10}em`
  if (text.textTransform) css['text-transform'] = text.textTransform

  if (paragraph.align) css['text-align'] = paragraph.align
  if (paragraph.lineHeight !== undefined) css['line-height'] = String(paragraph.lineHeight)
  if (paragraph.spaceBefore !== undefined) css['margin-top'] = `${paragraph.spaceBefore}pt`
  if (paragraph.spaceAfter !== undefined) css['margin-bottom'] = `${paragraph.spaceAfter}pt`
  if (paragraph.indentLeft !== undefined) css['margin-left'] = `${paragraph.indentLeft}pt`
  if (paragraph.indentRight !== undefined) css['margin-right'] = `${paragraph.indentRight}pt`
  if (paragraph.firstLineIndent !== undefined) css['text-indent'] = `${paragraph.firstLineIndent}pt`
  if (paragraph.pageBreakBefore) css['break-before'] = 'page'

  return css
}

function block(selector: string, style: NamedStyle, styles: NamedStyle[]): string {
  const body = Object.entries(declarations(style, styles))
    .map(([property, value]) => `  ${property}: ${value};`)
    .join('\n')
  // `!important` is never used: direct formatting has to be able to win, exactly
  // as it does in Word.
  return `${selector} {\n${body}\n}`
}

/**
 * The style a block of this type falls back to when it carries no style id —
 * documents imported from elsewhere, and anything written before a style was
 * applied.
 */
export function defaultStyleFor(
  blockType: 'paragraph' | 'heading',
  level: number | undefined,
  styles: NamedStyle[],
  defaultStyleId: string
): NamedStyle | undefined {
  if (blockType === 'heading' && level !== undefined) {
    return (
      styles.find((style) => style.id === `heading-${level}`) ??
      styles.find((style) => style.headingLevel === level)
    )
  }
  return styles.find((style) => style.id === defaultStyleId) ?? styles[0]
}

/**
 * Build the stylesheet for a project's styles. Kept pure so it can be tested and
 * reused for style previews in the toolbar.
 */
export function generateStyleSheet(styles: NamedStyle[], defaultStyleId = 'body'): string {
  const rules = styles.map((style) => block(`.pub-style-${style.id}`, style, styles))

  // Blocks with no style of their own still need to look like the manuscript
  // rather than like raw browser defaults, so each block type gets a fallback
  // rule. `:not([data-style])` keeps an explicit style winning.
  const paragraphDefault = defaultStyleFor('paragraph', undefined, styles, defaultStyleId)
  if (paragraphDefault) {
    rules.push(block('.pub-prose p:not([data-style])', paragraphDefault, styles))
  }
  for (const level of [1, 2, 3, 4, 5, 6]) {
    const headingDefault = defaultStyleFor('heading', level, styles, defaultStyleId)
    if (headingDefault) {
      rules.push(block(`.pub-prose h${level}:not([data-style])`, headingDefault, styles))
    }
  }

  return rules.join('\n\n')
}

/** Inline CSS for previewing a style in a menu, at a legible size. */
export function previewStyle(style: NamedStyle, styles: NamedStyle[]): CSSProperties {
  const resolved = resolveStyle(style.id, styles)
  if (!resolved) return {}
  const { text } = resolved
  return {
    fontFamily: text.fontFamily,
    fontWeight: text.bold ? 700 : 400,
    fontStyle: text.italic ? 'italic' : 'normal',
    textTransform: text.textTransform,
    letterSpacing: text.letterSpacing ? `${text.letterSpacing / 10}em` : undefined
  }
}
