import { z } from 'zod'

/** Character-level defaults of a named style. Lengths are points. */
export const textStyleAttrsSchema = z.object({
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: z.string().optional(),
  backgroundColor: z.string().optional(),
  letterSpacing: z.number().optional(),
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).optional()
})
export type TextStyleAttrs = z.infer<typeof textStyleAttrsSchema>

/** Paragraph-level defaults of a named style. Lengths are points. */
export const paragraphStyleAttrsSchema = z.object({
  align: z.enum(['left', 'center', 'right', 'justify']).optional(),
  lineHeight: z.number().optional(),
  spaceBefore: z.number().optional(),
  spaceAfter: z.number().optional(),
  indentLeft: z.number().optional(),
  indentRight: z.number().optional(),
  firstLineIndent: z.number().optional(),
  keepWithNext: z.boolean().optional(),
  pageBreakBefore: z.boolean().optional()
})
export type ParagraphStyleAttrs = z.infer<typeof paragraphStyleAttrsSchema>

/**
 * How a heading level numbers itself: "1.2.3". `levelText` is Word's own
 * `w:lvlText` syntax (`%1.%2.%3 ` — `%n` is the counter at outline level n),
 * deliberately, because that is what the DOCX export has to emit anyway —
 * inventing a friendlier syntax would just mean writing a translator to this
 * one.
 */
export const numberingSchema = z.object({
  format: z.enum(['decimal', 'upper-roman', 'lower-roman', 'upper-alpha', 'lower-alpha']),
  startAt: z.number().int().min(0).default(1),
  levelText: z.string()
})
export type Numbering = z.infer<typeof numberingSchema>

/**
 * A named style, Word-style: a reusable bundle of paragraph + character defaults.
 * Documents reference styles by id, so editing a style restyles every document
 * without rewriting any content.
 */
export const namedStyleSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Built-in styles cannot be deleted, only edited. */
  builtin: z.boolean().default(false),
  /** Inherit unset attributes from this style. */
  basedOn: z.string().optional(),
  /** Style applied to the paragraph created by pressing Enter at the end of this one. */
  nextStyle: z.string().optional(),
  /** Renders as an <h1>-<h6> instead of a <p> when set. */
  headingLevel: z.number().int().min(1).max(6).optional(),
  /**
   * A paragraph in this style is a table-of-contents / cross-reference target
   * at this level. Defaults to `headingLevel` when unset, so every existing
   * heading style is already "in the contents" without editing a project's
   * styles — but a style that isn't a heading at all (a numbered "Part" title,
   * styled as its own paragraph style) can still opt in.
   */
  outlineLevel: z.number().int().min(1).max(6).optional(),
  /**
   * "1.2.3"-style numbering for this style's outline level. Absent means the
   * level renders unnumbered, exactly as it does today.
   */
  numbering: numberingSchema.optional(),
  /**
   * A ring of style ids this style cycles through on Tab — screenplay
   * elements ("this line could *instead* be a Character line"), not the
   * "what comes *next*" relationship `nextStyle` already covers. Absent means
   * Tab does nothing style-related. Walking the ring is bounded by the style
   * count, since a chain that never returns to its start is malformed data,
   * not a bug to crash on.
   */
  cycleStyle: z.string().optional(),
  text: textStyleAttrsSchema.default({}),
  paragraph: paragraphStyleAttrsSchema.default({})
})
export type NamedStyle = z.infer<typeof namedStyleSchema>

export const STYLE_BODY = 'body'

/**
 * Conventional ids a screenplay template's six styles carry. Neither the
 * editor nor the model has a "this style is a screenplay element" flag —
 * the scene-heading autocomplete and the Fountain import/export both key off
 * these ids directly, the same way `STYLE_BODY` is already a convention
 * rather than a schema field.
 */
export const STYLE_SCENE_HEADING = 'scene-heading'
export const STYLE_ACTION = 'action'
export const STYLE_CHARACTER = 'character-cue'
export const STYLE_PARENTHETICAL = 'parenthetical'
export const STYLE_DIALOGUE = 'dialogue'
export const STYLE_TRANSITION = 'transition'

/** Seeded into every new project; users may edit these but not remove them. */
export const BUILTIN_STYLES: NamedStyle[] = [
  {
    id: STYLE_BODY,
    name: 'Body',
    builtin: true,
    nextStyle: STYLE_BODY,
    text: { fontFamily: 'Georgia, serif', fontSize: 12 },
    paragraph: { align: 'left', lineHeight: 1.6, spaceAfter: 8, firstLineIndent: 0 }
  },
  {
    id: 'first-paragraph',
    name: 'First Paragraph',
    builtin: true,
    basedOn: STYLE_BODY,
    nextStyle: 'indented-body',
    text: {},
    paragraph: { firstLineIndent: 0 }
  },
  {
    id: 'indented-body',
    name: 'Indented Body',
    builtin: true,
    basedOn: STYLE_BODY,
    nextStyle: 'indented-body',
    text: {},
    paragraph: { firstLineIndent: 24, spaceAfter: 0 }
  },
  {
    id: 'heading-1',
    name: 'Heading 1',
    builtin: true,
    headingLevel: 1,
    nextStyle: 'first-paragraph',
    text: { fontFamily: 'Georgia, serif', fontSize: 24, bold: true },
    paragraph: { align: 'left', lineHeight: 1.25, spaceBefore: 24, spaceAfter: 12 }
  },
  {
    id: 'heading-2',
    name: 'Heading 2',
    builtin: true,
    headingLevel: 2,
    nextStyle: 'first-paragraph',
    text: { fontFamily: 'Georgia, serif', fontSize: 18, bold: true },
    paragraph: { align: 'left', lineHeight: 1.3, spaceBefore: 18, spaceAfter: 8 }
  },
  {
    id: 'heading-3',
    name: 'Heading 3',
    builtin: true,
    headingLevel: 3,
    nextStyle: 'first-paragraph',
    text: { fontFamily: 'Georgia, serif', fontSize: 15, bold: true },
    paragraph: { align: 'left', lineHeight: 1.35, spaceBefore: 14, spaceAfter: 6 }
  },
  {
    id: 'heading-4',
    name: 'Heading 4',
    builtin: true,
    headingLevel: 4,
    nextStyle: 'first-paragraph',
    text: { fontFamily: 'Georgia, serif', fontSize: 13, bold: true },
    paragraph: { align: 'left', lineHeight: 1.4, spaceBefore: 12, spaceAfter: 6 }
  },
  {
    id: 'heading-5',
    name: 'Heading 5',
    builtin: true,
    headingLevel: 5,
    nextStyle: 'first-paragraph',
    text: { fontFamily: 'Georgia, serif', fontSize: 12, bold: true },
    paragraph: { align: 'left', lineHeight: 1.4, spaceBefore: 12, spaceAfter: 4 }
  },
  {
    id: 'heading-6',
    name: 'Heading 6',
    builtin: true,
    headingLevel: 6,
    nextStyle: 'first-paragraph',
    text: { fontFamily: 'Georgia, serif', fontSize: 12, bold: false, italic: true },
    paragraph: { align: 'left', lineHeight: 1.4, spaceBefore: 12, spaceAfter: 4 }
  },
  {
    id: 'chapter-title',
    name: 'Chapter Title',
    builtin: true,
    headingLevel: 1,
    nextStyle: 'first-paragraph',
    text: { fontFamily: 'Georgia, serif', fontSize: 28, bold: false, textTransform: 'uppercase', letterSpacing: 2 },
    paragraph: { align: 'center', lineHeight: 1.2, spaceBefore: 48, spaceAfter: 32 }
  },
  {
    id: 'scene-break',
    name: 'Scene Break',
    builtin: true,
    nextStyle: 'first-paragraph',
    text: { fontFamily: 'Georgia, serif', fontSize: 12 },
    paragraph: { align: 'center', spaceBefore: 16, spaceAfter: 16 }
  },
  {
    id: 'block-quote',
    name: 'Block Quote',
    builtin: true,
    basedOn: STYLE_BODY,
    nextStyle: STYLE_BODY,
    text: { italic: true },
    paragraph: { indentLeft: 36, indentRight: 36, spaceBefore: 12, spaceAfter: 12 }
  }
]

/**
 * The styles a `cycleStyle` ring visits after `startId`, in order, stopping
 * once it returns to `startId` — or, for a ring some hand-edit left without a
 * way back to its start, once it has taken as many hops as there are styles.
 * That bound is what makes this safe to call on data this build did not
 * write itself: a chain that never closes still terminates instead of
 * walking forever.
 */
export function cycleRing(startId: string, styles: NamedStyle[]): string[] {
  const byId = new Map(styles.map((style) => [style.id, style]))
  const visited: string[] = []
  let cursor = byId.get(startId)?.cycleStyle
  while (cursor && cursor !== startId && visited.length < styles.length) {
    visited.push(cursor)
    cursor = byId.get(cursor)?.cycleStyle
  }
  return visited
}

/** Resolve a style against its `basedOn` chain. Cycles are broken by a depth cap. */
export function resolveStyle(
  styleId: string,
  styles: NamedStyle[]
): { text: TextStyleAttrs; paragraph: ParagraphStyleAttrs; headingLevel?: number; outlineLevel?: number } | null {
  const byId = new Map(styles.map((s) => [s.id, s]))
  const chain: NamedStyle[] = []
  let cursor = byId.get(styleId)
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor.id) && chain.length < 16) {
    seen.add(cursor.id)
    chain.unshift(cursor)
    cursor = cursor.basedOn ? byId.get(cursor.basedOn) : undefined
  }
  if (chain.length === 0) return null
  const text: TextStyleAttrs = {}
  const paragraph: ParagraphStyleAttrs = {}
  let headingLevel: number | undefined
  let outlineLevel: number | undefined
  for (const style of chain) {
    Object.assign(text, style.text)
    Object.assign(paragraph, style.paragraph)
    if (style.headingLevel !== undefined) headingLevel = style.headingLevel
    if (style.outlineLevel !== undefined) outlineLevel = style.outlineLevel
  }
  return { text, paragraph, headingLevel, outlineLevel }
}
