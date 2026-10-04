import { Mark, Extension, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, type Transaction, type EditorState } from '@tiptap/pm/state'
import type { Mark as PmMark, Node as PmNode } from '@tiptap/pm/model'
import { AI_AUTHORED_MARK } from '@shared/model/provenance.js'
import { forEachStepRange } from './stepRanges.js'

/**
 * Text the assistant wrote, marked as such.
 *
 * The mark is attribution, not formatting: a dotted underline and a tooltip
 * saying which model wrote these words and when. It is deliberately hard to
 * lose by accident — see `ProvenanceGuard` — and deliberately easy to lose on
 * purpose: delete the words and the mark goes with them, as it should. The
 * document's envelope keeps the permanent record (`provenance.ts`).
 */
function attribute(name: string, dom: string) {
  return {
    [name]: {
      default: '',
      parseHTML: (element: HTMLElement) => element.getAttribute(dom) ?? '',
      renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { [dom]: String(attrs[name]) } : {})
    }
  }
}

export const AiAuthored = Mark.create({
  name: AI_AUTHORED_MARK,
  // Typing at the end of the assistant's words is the writer's own writing.
  inclusive: false,
  keepOnSplit: true,
  excludes: '',

  addAttributes() {
    return {
      ...attribute('runId', 'data-run'),
      ...attribute('model', 'data-model'),
      ...attribute('at', 'data-at'),
      ...attribute('authorId', 'data-author-id')
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-ai-authored]' }]
  },

  renderHTML({ HTMLAttributes, mark }) {
    const model = String(mark.attrs.model || 'the assistant')
    const at = String(mark.attrs.at || '')
    const when = at ? ` on ${at.slice(0, 10)}` : ''
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-ai-authored': '1',
        class: 'pub-ai-authored',
        title: `Written by ${model}${when}`
      }),
      0
    ]
  }
})

export const provenanceGuardKey = new PluginKey('pub-provenance-guard')

/**
 * Keeps the mark on words that survive a formatting change.
 *
 * "Clear formatting", a style applied over a selection, a paste that replaces
 * a range with the same text: each strips every mark from the range, and
 * attribution must not be one of the casualties. After any transaction, each
 * range that carried the mark before is mapped forward; where the mapped
 * range still holds the same text and has lost the mark, it is put back.
 * Deleted or retyped text maps to nothing or to different words, and nothing
 * is re-added — removing the assistant's words remains the writer's right.
 */
export const ProvenanceGuard = Extension.create({
  name: 'provenanceGuard',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: provenanceGuardKey,
        appendTransaction: (transactions, oldState, newState) => restoreMarks(transactions, oldState, newState)
      })
    ]
  }
})

interface MarkedRange {
  from: number
  to: number
  text: string
  mark: PmMark
}

function markedRanges(state: EditorState): MarkedRange[] {
  const ranges: MarkedRange[] = []
  state.doc.descendants((node, position) => {
    if (!node.isText) return true
    const mark = node.marks.find((candidate) => candidate.type.name === AI_AUTHORED_MARK)
    if (mark) ranges.push({ from: position, to: position + node.nodeSize, text: node.text ?? '', mark })
    return true
  })
  return ranges
}

const carriesAiMark = (node: PmNode): boolean =>
  node.isText && node.marks.some((mark) => mark.type.name === AI_AUTHORED_MARK)

/**
 * Attribution can only be lost from text a step actually touched, so an edit
 * nowhere near the assistant's words skips the whole-document scan below.
 * Only the side before each step matters: the guard restores marks that
 * existed, it never invents new ones.
 */
export function touchesAiText(transaction: Transaction): boolean {
  let touched = false
  forEachStepRange(transaction, (range) => {
    if (touched) return
    range.before.nodesBetween(range.from, Math.min(range.to, range.before.content.size), (node) => {
      if (touched) return false
      if (carriesAiMark(node)) touched = true
      return !touched
    })
  })
  return touched
}

export function restoreMarks(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState
): Transaction | null {
  if (!transactions.some((transaction) => transaction.docChanged)) return null
  if (transactions.some((transaction) => transaction.getMeta(provenanceGuardKey))) return null
  if (!transactions.some(touchesAiText)) return null
  const before = markedRanges(oldState)
  if (before.length === 0) return null

  const markType = newState.schema.marks[AI_AUTHORED_MARK]
  if (!markType) return null

  let restoring: Transaction | null = null
  for (const range of before) {
    let from = range.from
    let to = range.to
    for (const transaction of transactions) {
      from = transaction.mapping.map(from, 1)
      to = transaction.mapping.map(to, -1)
    }
    if (to <= from) continue
    if (newState.doc.textBetween(from, to) !== range.text) continue
    if (newState.doc.rangeHasMark(from, to, markType)) continue
    restoring ??= newState.tr
    restoring.addMark(from, to, markType.create(range.mark.attrs))
  }
  if (!restoring) return null
  restoring.setMeta(provenanceGuardKey, true)
  restoring.setMeta('addToHistory', false)
  return restoring
}
