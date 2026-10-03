import { z } from 'zod'
import type { PmDoc, PmMark, PmNode } from '../model/document.js'
import { INSERTION_MARK, DELETION_MARK } from '../model/suggestion.js'
import { ANCHOR_MARK } from '../model/anchor.js'
import { MENTION_MARK } from '../model/mention.js'
import { extractRawBlocks, forEachTextNode, normalizeBlockText, type RawTextNode } from './extractText.js'
import { applyAnchorMark } from './anchors.js'

/**
 * What the assistant may do to a document, as data.
 *
 * An edit is a list of operations addressed by block index and normalised
 * text offsets — the same coordinates mentions, anchors and search hits use —
 * never by ProseMirror position. That is what lets one description be applied
 * two ways: in the open editor by the renderer, or to the file's JSON by main
 * when the document is closed. Both call `applyAssistantEdit`, so the two
 * paths cannot disagree about what a proposal does.
 *
 * In `suggest` mode nothing is removed and nothing is accepted: replaced text
 * gains a `deletion` mark, new text arrives under an `insertion` mark, and
 * Phase 9's review panel owns the verdict. `direct` mode splices the text in
 * plainly, and exists only for writers who have asked for it.
 */
const offset = z.number().int().min(0)

export const assistantEditOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('replace'),
    blockIndex: offset,
    start: offset,
    end: offset,
    text: z.string(),
    reason: z.string().default('')
  }),
  z.object({ kind: z.literal('append'), text: z.string(), reason: z.string().default('') }),
  z.object({ kind: z.literal('anchor'), blockIndex: offset, start: offset, end: offset, anchorId: z.string() })
])
export type AssistantEditOp = z.infer<typeof assistantEditOpSchema>

export const assistantEditModes = ['suggest', 'direct'] as const

export const assistantEditSchema = z.object({
  id: z.string(),
  /** The agent run that produced it — the chat request id. */
  runId: z.string(),
  docId: z.string(),
  docPath: z.string(),
  authorId: z.string(),
  model: z.string().default(''),
  at: z.string(),
  mode: z.enum(assistantEditModes),
  ops: z.array(assistantEditOpSchema).min(1)
})
export type AssistantEdit = z.infer<typeof assistantEditSchema>

export interface AppliedEdit {
  doc: PmDoc
  /** Indices into `edit.ops` that could not be applied. */
  failed: number[]
}

/**
 * Marks that travel with the surrounding prose when new text is spliced in.
 *
 * Formatting does; identity does not. A mention, an anchor or a pending
 * suggestion names something specific about *that* text, and copying it onto
 * text the assistant wrote would claim the new words are the same thing.
 */
const IDENTITY_MARKS = new Set<string>([INSERTION_MARK, DELETION_MARK, ANCHOR_MARK, MENTION_MARK, 'highlight'])

export function applyAssistantEdit(doc: PmDoc, edit: AssistantEdit): AppliedEdit {
  const failed: number[] = []
  let current = doc

  // Within one block, later offsets first, so an earlier op never shifts the
  // coordinates a later one was addressed in. Appends go last for the same
  // reason, and anchors with their block's other ops.
  const indexed = edit.ops.map((op, index) => ({ op, index }))
  const placed = indexed
    .filter((entry) => entry.op.kind !== 'append')
    .sort((a, b) => {
      const left = a.op as Extract<AssistantEditOp, { blockIndex: number }>
      const right = b.op as Extract<AssistantEditOp, { blockIndex: number }>
      return right.blockIndex - left.blockIndex || right.start - left.start || b.index - a.index
    })
  const appends = indexed.filter((entry) => entry.op.kind === 'append')

  for (const { op, index } of [...placed, ...appends]) {
    const next = applyOp(current, op, edit)
    if (next) current = next
    else failed.push(index)
  }
  failed.sort((a, b) => a - b)
  return { doc: current, failed }
}

function applyOp(doc: PmDoc, op: AssistantEditOp, edit: AssistantEdit): PmDoc | null {
  if (op.kind === 'anchor') return applyAnchorMark(doc, op.blockIndex, op.start, op.end, op.anchorId)
  if (op.kind === 'append') return appendBlocks(doc, op.text, edit)
  return replaceInBlock(doc, op, edit)
}

function suggestionAttrs(edit: AssistantEdit): Record<string, unknown> {
  return { authorId: edit.authorId, at: edit.at }
}

function appendBlocks(doc: PmDoc, text: string, edit: AssistantEdit): PmDoc | null {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  if (paragraphs.length === 0) return null
  const marks: PmMark[] = edit.mode === 'suggest' ? [{ type: INSERTION_MARK, attrs: suggestionAttrs(edit) }] : []
  const blocks: PmNode[] = paragraphs.map((paragraph) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: paragraph, ...(marks.length ? { marks } : {}) }]
  }))
  return { ...doc, content: [...(doc.content ?? []), ...blocks] }
}

function replaceInBlock(
  doc: PmDoc,
  op: Extract<AssistantEditOp, { kind: 'replace' }>,
  edit: AssistantEdit
): PmDoc | null {
  if (op.end < op.start) return null
  if (op.start === op.end && !op.text) return null

  const blocks = extractRawBlocks(doc)
  const block = blocks[op.blockIndex]
  if (!block || block.index !== op.blockIndex) return null

  const { map } = normalizeBlockText(block.text)
  const rawStart = map[op.start]
  const rawEnd = map[op.end]
  if (rawStart === undefined || rawEnd === undefined || rawEnd < rawStart) return null

  const content = [...(doc.content ?? [])]
  const clone = structuredClone(content[op.blockIndex]!) as PmNode
  const inserting = rawStart === rawEnd

  const targets: RawTextNode[] = []
  forEachTextNode(clone, (entry) => {
    if (entry.node.type !== 'text') return
    if (inserting ? entry.start <= rawStart && rawStart <= entry.end : entry.start < rawEnd && rawStart < entry.end) {
      targets.push(entry)
    }
  })

  const insertion: PmNode | null = op.text ? newTextNode(op.text, targets.at(-1)?.node.marks ?? [], edit) : null

  if (targets.length === 0) {
    // An empty paragraph has no text node to split, but is still a place to
    // put words. Anything deeper — an empty list item — is left to the editor.
    if (!inserting || rawStart !== 0 || !insertion) return null
    if (clone.content?.length) return null
    content[op.blockIndex] = { ...clone, content: [insertion] }
    return { ...doc, content }
  }

  // For a pure insertion several nodes can touch the offset (one ending there,
  // one starting there). The one that *contains* it wins; failing that, the
  // last one ending there, so the new text follows what came before it.
  const chosen = inserting
    ? [targets.find((entry) => entry.start <= rawStart && rawStart < entry.end) ?? targets.at(-1)!]
    : targets

  const deletion: PmMark | null =
    edit.mode === 'suggest' && !inserting ? { type: DELETION_MARK, attrs: suggestionAttrs(edit) } : null

  for (let i = chosen.length - 1; i >= 0; i--) {
    const entry = chosen[i]!
    const localStart = Math.max(rawStart, entry.start) - entry.start
    const localEnd = Math.min(rawEnd, entry.end) - entry.start
    const pieces = splitTextNode(entry.node, localStart, localEnd, deletion, i === chosen.length - 1 ? insertion : null)
    entry.parent.splice(entry.index, 1, ...pieces)
  }

  content[op.blockIndex] = clone
  return { ...doc, content }
}

function newTextNode(text: string, neighbouring: PmMark[], edit: AssistantEdit): PmNode {
  const carried = neighbouring.filter((mark) => !IDENTITY_MARKS.has(mark.type))
  const marks = edit.mode === 'suggest' ? [...carried, { type: INSERTION_MARK, attrs: suggestionAttrs(edit) }] : carried
  return { type: 'text', text, ...(marks.length ? { marks } : {}) }
}

/**
 * Split `[start, end)` out of a text node. The middle piece is struck through
 * (`deletion` given) or dropped (`direct` mode); `insertion`, when given, goes
 * where the middle piece ended.
 */
function splitTextNode(
  node: PmNode,
  start: number,
  end: number,
  deletion: PmMark | null,
  insertion: PmNode | null
): PmNode[] {
  const text = node.text ?? ''
  const pieces: PmNode[] = []
  const before = text.slice(0, start)
  const inside = text.slice(start, end)
  const after = text.slice(end)
  if (before) pieces.push({ ...node, text: before })
  if (inside && deletion) pieces.push({ ...node, text: inside, marks: [...(node.marks ?? []), deletion] })
  if (insertion) pieces.push(insertion)
  if (after) pieces.push({ ...node, text: after })
  return pieces
}
