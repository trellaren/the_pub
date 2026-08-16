import type { PmDoc, PmNode } from '../../shared/model/document.js'
import {
  STYLE_SCENE_HEADING,
  STYLE_ACTION,
  STYLE_CHARACTER,
  STYLE_PARENTHETICAL,
  STYLE_DIALOGUE,
  STYLE_TRANSITION
} from '../../shared/model/style.js'
import { SCENE_HEADING_PREFIX } from './toFountain.js'

/**
 * Reading a `.fountain`.
 *
 * Parsed against hand-built fixtures (`fixtures.ts`) modelled on what
 * Final Draft and Highland actually write, not round-tripped only through
 * `toFountain.ts` — the same asymmetry `docx/fromDocx.ts` documents, and for
 * the same reason: that would only prove this agrees with itself.
 *
 * Deliberately narrower than the format: title-page keys beyond `Title`,
 * sections/synopses, notes, the boneyard, centred text, dual dialogue and
 * page breaks are not recognised. Each survives as an action line rather
 * than vanishing — a screenplay pasted in from elsewhere keeps its words,
 * just not every one of Fountain's typographic conventions.
 */
export interface FountainImport {
  content: PmDoc
  title: string | null
}

export function importFountain(source: string): FountainImport {
  const rawLines = source.split(/\r\n|\r|\n/)
  const { title, bodyStart } = readTitlePage(rawLines)
  const blocks = splitBlocks(rawLines.slice(bodyStart))

  const content: PmNode[] = []
  for (const block of blocks) {
    content.push(...blockToNodes(block))
  }

  return { content: { type: 'doc', content }, title }
}

/**
 * Fountain's title page: `Key: value` lines at the very top, ending at the
 * first blank line — recognised only when the first line itself matches, so
 * a screenplay that opens straight with a scene heading is never misread.
 */
function readTitlePage(lines: string[]): { title: string | null; bodyStart: number } {
  if (!TITLE_PAGE_KEY.test(lines[0] ?? '')) return { title: null, bodyStart: 0 }
  let title: string | null = null
  let index = 0
  for (; index < lines.length; index++) {
    const line = lines[index]!
    if (line.trim() === '') break
    const match = TITLE_PAGE_KEY.exec(line)
    if (match && match[1]!.trim().toLowerCase() === 'title') title = match[2]!.trim()
  }
  return { title, bodyStart: index + 1 }
}

const TITLE_PAGE_KEY = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/

/** Non-blank lines, grouped by the blank lines between them. */
function splitBlocks(lines: string[]): string[][] {
  const blocks: string[][] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) blocks.push(current)
      current = []
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current)
  return blocks
}

function blockToNodes(block: string[]): PmNode[] {
  const first = block[0]!.trim()

  if (first.startsWith('.') && !first.startsWith('..')) {
    return [heading(first.slice(1)), ...block.slice(1).map(action)]
  }
  if (SCENE_HEADING_PREFIX.test(first)) {
    return [heading(first), ...block.slice(1).map(action)]
  }
  if (first.startsWith('>') && !first.endsWith('<')) {
    return [transition(first.slice(1))]
  }
  if (block.length === 1 && /TO:\s*$/.test(first) && isAllCaps(first)) {
    return [transition(first)]
  }
  if (block.length > 1 && isAllCaps(first)) {
    return [character(first), ...block.slice(1).map(cueLine)]
  }

  // Action: a block with no other marker. Multiple lines in one block (no
  // blank line between them) join into one paragraph — Fountain's own rule
  // for a hard line break inside action needs a trailing double-space, which
  // this import does not distinguish from ordinary wrapping.
  return [action(block.join(' '))]
}

function cueLine(line: string): PmNode {
  const trimmed = line.trim()
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) return parenthetical(trimmed.slice(1, -1))
  return dialogue(trimmed)
}

/** No lowercase letter, and at least one letter — the heuristic every Fountain parser uses for a character cue. */
function isAllCaps(line: string): boolean {
  return !/[a-z]/.test(line) && /[A-Za-z]/.test(line)
}

function paragraph(styleId: string, text: string): PmNode {
  return { type: 'paragraph', attrs: { styleId }, content: text ? [{ type: 'text', text }] : [] }
}

const heading = (text: string): PmNode => paragraph(STYLE_SCENE_HEADING, text.trim())
const action = (text: string): PmNode => paragraph(STYLE_ACTION, text.trim())
const character = (text: string): PmNode => paragraph(STYLE_CHARACTER, text.trim())
const parenthetical = (text: string): PmNode => paragraph(STYLE_PARENTHETICAL, text.trim())
const dialogue = (text: string): PmNode => paragraph(STYLE_DIALOGUE, text.trim())
const transition = (text: string): PmNode => paragraph(STYLE_TRANSITION, text.trim())
