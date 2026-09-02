import type { PmDoc, PmNode } from '../../shared/model/document.js'
import {
  STYLE_SCENE_HEADING,
  STYLE_ACTION,
  STYLE_CHARACTER,
  STYLE_PARENTHETICAL,
  STYLE_DIALOGUE,
  STYLE_TRANSITION
} from '../../shared/model/style.js'

/**
 * Writing a `.fountain`.
 *
 * Fountain is plain text with a handful of formatting rules, so this is a
 * serialiser Quoth owns outright rather than a wrapper around a library —
 * the same asymmetry `docx/` keeps: export goes through code proven by this
 * app's own conventions, import (`fromFountain.ts`) is checked against
 * fixtures modelled on what other tools actually write.
 *
 * Six element styles, by conventional id (`shared/model/style.ts`) — nothing
 * else in a document's own shape says "this paragraph is a screenplay
 * element". A paragraph in none of them exports as action, which is
 * Fountain's own default for a line that isn't otherwise marked up.
 */
export interface ExportFountainOptions {
  title?: string
}

export function exportFountain(doc: PmDoc, options: ExportFountainOptions = {}): string {
  const lines: string[] = []
  if (options.title) {
    lines.push(`Title: ${options.title}`, '')
  }

  const blocks = doc.content ?? []
  let previousWasCue = false
  for (const node of blocks) {
    const kind = elementKind(node)
    const text = plainText(node)
    if (!text) continue

    // A blank line separates every element *except* the lines directly under
    // a character cue (a parenthetical or dialogue), which must stay
    // contiguous for a parser to read them as one speech.
    const contiguous: boolean = previousWasCue && (kind === 'parenthetical' || kind === 'dialogue')
    if (lines.length > 0 && !contiguous) lines.push('')

    lines.push(fountainLine(kind, text))
    previousWasCue = kind === 'character' || contiguous
  }

  return lines.join('\n') + '\n'
}

type ElementKind = 'scene-heading' | 'action' | 'character' | 'parenthetical' | 'dialogue' | 'transition'

function elementKind(node: PmNode): ElementKind {
  const styleId = typeof node.attrs?.styleId === 'string' ? node.attrs.styleId : null
  switch (styleId) {
    case STYLE_SCENE_HEADING:
      return 'scene-heading'
    case STYLE_CHARACTER:
      return 'character'
    case STYLE_PARENTHETICAL:
      return 'parenthetical'
    case STYLE_DIALOGUE:
      return 'dialogue'
    case STYLE_TRANSITION:
      return 'transition'
    case STYLE_ACTION:
    default:
      return 'action'
  }
}

function fountainLine(kind: ElementKind, text: string): string {
  switch (kind) {
    case 'scene-heading':
      // Forced (`.`) unless it already reads as one of Fountain's recognised
      // prefixes — forcing unconditionally would round-trip fine but litters
      // a file a human might also open with a leading dot on every heading.
      return SCENE_HEADING_PREFIX.test(text) ? text : `.${text}`
    case 'character':
      // Forced (`^` suffix is dual dialogue, out of scope) — uppercase is
      // what makes a cue a cue, and an author may not have typed it that way.
      return text.toUpperCase()
    case 'parenthetical':
      return text.startsWith('(') && text.endsWith(')') ? text : `(${text})`
    case 'transition':
      // Forced (`>`) unconditionally: the alternative is emitting only when
      // the text already ends "TO:" in caps, which would silently drop the
      // marker (and the round trip) for a transition an author phrased
      // differently ("SMASH CUT TO BLACK.", "DISSOLVE.").
      return `>${text}`
    case 'action':
    case 'dialogue':
      return text
  }
}

/** What other Fountain tools recognise as a scene heading without a forcing `.` — shared with `fromFountain.ts`. */
export const SCENE_HEADING_PREFIX = /^(int|ext|est|int\.?\/ext|i\/e)[. ]/i

function plainText(node: PmNode): string {
  return (node.content ?? []).map(runText).join('')
}

function runText(node: PmNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return ' '
  return (node.content ?? []).map(runText).join('')
}
