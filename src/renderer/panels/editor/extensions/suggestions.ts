import { Mark, Extension, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, Selection, type Transaction, type EditorState } from '@tiptap/pm/state'
import { Slice, type Node as PmNode } from '@tiptap/pm/model'
import { Mapping, ReplaceStep, type StepMap } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'
import { INSERTION_MARK, DELETION_MARK } from '@shared/model/suggestion.js'
import { colorForAuthor, describeAuthor } from '@shared/model/author.js'

/**
 * Suggested edits in the editor.
 *
 * Two marks and one plugin. The marks are ordinary and dull; the plugin is the
 * hardest code in the phase, because it has to turn "the user deleted
 * something" into "the user proposed a deletion" without ever letting the text
 * actually leave the document.
 */

interface SuggestionOptions {
  /** Who is suggesting. Empty while suggesting mode is off. */
  authorId: string
  enabled: boolean
}

/**
 * The author's tint, as a custom property the stylesheet reads.
 *
 * Derived from the id here rather than looked up in the project registry: this
 * runs on every render of every suggestion, and a registry lookup would couple
 * the editor schema to a store it has no other reason to know about. The
 * derived colour is the same one `describeAuthor` falls back to, so a reviewer
 * looks the same in the margin as they do in the text.
 */
function tint(attrs: Record<string, unknown>): Record<string, string> {
  const authorId = String(attrs.authorId ?? '')
  return authorId ? { style: `--pub-author-color: ${colorForAuthor(authorId)}` } : {}
}

/**
 * A visually hidden run announcing what the mark means, spoken as part of the
 * text a screen reader is already reading — not a separate stop, and not a
 * name lookup against the project roster, which the schema has no reason to
 * know about (see `tint`'s comment above).
 *
 * `contenteditable="false"` keeps ProseMirror's cursor mapping out of it: this
 * is decoration around the mark's real content hole, not part of the document.
 */
function srLabel(kind: 'insertion' | 'deletion', attrs: Record<string, unknown>) {
  const authorId = String(attrs.authorId ?? '')
  const author = describeAuthor(authorId, [])
  const text = kind === 'insertion' ? `insertion, by ${author.name}: ` : `deletion, by ${author.name}: `
  return ['span', { class: 'pub-sr-only', contenteditable: 'false' }, text] as const
}

function attributes() {
  return {
    authorId: {
      default: '',
      parseHTML: (element: HTMLElement) => element.getAttribute('data-author') ?? '',
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.authorId ? { 'data-author': String(attrs.authorId) } : {}
    },
    at: {
      default: '',
      parseHTML: (element: HTMLElement) => element.getAttribute('data-at') ?? '',
      renderHTML: (attrs: Record<string, unknown>) => (attrs.at ? { 'data-at': String(attrs.at) } : {})
    }
  }
}

/**
 * `excludes: ''` on both, for the reason `Anchors` records: two reviewers
 * touching overlapping text is the ordinary case, and ProseMirror's default of
 * excluding a mark's own type would silently make the second one impossible.
 */
export const Insertion = Mark.create({
  name: INSERTION_MARK,
  inclusive: true,
  keepOnSplit: true,
  excludes: '',
  addAttributes: attributes,
  parseHTML() {
    return [{ tag: 'ins[data-author]' }, { tag: 'span[data-suggestion="insertion"]' }]
  },
  renderHTML({ HTMLAttributes, mark }) {
    // The content hole must be the only child of its parent, so the label sits
    // beside it as a sibling of a wrapper rather than beside the hole itself.
    return [
      'ins',
      mergeAttributes(HTMLAttributes, { class: 'pub-insertion' }, tint(mark.attrs)),
      srLabel('insertion', mark.attrs),
      ['span', {}, 0]
    ]
  }
})

export const Deletion = Mark.create({
  name: DELETION_MARK,
  // Not inclusive: typing at the end of struck-through text is new writing, not
  // more of the deletion.
  inclusive: false,
  keepOnSplit: true,
  excludes: '',
  addAttributes: attributes,
  parseHTML() {
    return [{ tag: 'del[data-author]' }, { tag: 'span[data-suggestion="deletion"]' }]
  },
  renderHTML({ HTMLAttributes, mark }) {
    return [
      'del',
      mergeAttributes(HTMLAttributes, { class: 'pub-deletion' }, tint(mark.attrs)),
      srLabel('deletion', mark.attrs),
      ['span', {}, 0]
    ]
  }
})

export const suggestionModeKey = new PluginKey<SuggestionOptions>('pub-suggesting')

/**
 * Suggesting mode.
 *
 * A plugin that rewrites transactions rather than a set of commands, because
 * the behaviour has to cover *every* way text can change — typing, pasting,
 * backspace, delete, cut, drag — and a command-level version would cover the
 * three someone remembered.
 *
 * The rules, in the order they matter:
 *
 * 1. Text that arrives gets the `insertion` mark.
 * 2. Text that would leave gets the `deletion` mark instead, and stays. A
 *    suggestion to delete must survive until it is judged.
 * 3. **Deleting your own pending insertion really deletes it.** Suggesting to
 *    remove your own suggestion collapses to nothing, and this is the case
 *    every tracked-changes implementation gets wrong first: without it,
 *    typing a word and immediately correcting a typo leaves an insertion of
 *    the typo struck through by a deletion, which is nonsense to read and
 *    impossible to accept cleanly.
 */
export const SuggestingMode = Extension.create<SuggestionOptions>({
  name: 'suggestingMode',

  addOptions() {
    return { authorId: '', enabled: false }
  },

  addProseMirrorPlugins() {
    const options = this.options
    // Per editor, not per module: a popped-out window has its own view, and a
    // shared reference would send one editor's rewrite to the other.
    let view: EditorView | null = null
    const pending: RewritePlan[] = []

    return [
      new Plugin<SuggestionOptions>({
        key: suggestionModeKey,
        state: {
          init: () => ({ ...options }),
          apply: (transaction, value, _oldState, newState) => {
            trackPending(pending, transaction, newState)
            const next = transaction.getMeta(suggestionModeKey) as SuggestionOptions | undefined
            return next ?? value
          }
        },
        view: (editorView) => {
          view = editorView
          return {
            destroy: () => {
              view = null
            }
          }
        },
        appendTransaction: (transactions, _oldState, newState) => markInsertions(transactions, newState),
        filterTransaction: (transaction, state) => {
          const plan = planRewrite(transaction, state)
          if (!plan) return true
          pending.push(plan)
          // Deferred, because dispatching from inside a filter re-enters it.
          // Built from the state current at dispatch time, not the one the
          // filter saw: anything that landed in between would otherwise make
          // this a transaction for a document that no longer exists.
          queueMicrotask(() => {
            pending.splice(pending.indexOf(plan), 1)
            if (!view || view.state.doc !== plan.doc) return
            const rewrite = applyPlan(plan, view.state)
            if (rewrite) view.dispatch(rewrite)
          })
          return false
        }
      })
    ]
  }
})

function modeOf(state: EditorState): SuggestionOptions {
  return suggestionModeKey.getState(state) ?? { authorId: '', enabled: false }
}

/**
 * Mark whatever was just inserted.
 *
 * Done as an appended transaction rather than by rewriting the original: the
 * original has already been mapped through, so the inserted ranges are known
 * exactly, and re-deriving them from a rewritten step is how off-by-one bugs
 * get in.
 */
function markInsertions(
  transactions: readonly Transaction[],
  newState: EditorState
): Transaction | null {
  const mode = modeOf(newState)
  if (!mode.enabled || !mode.authorId) return null
  if (!transactions.some((transaction) => transaction.docChanged)) return null
  // Our own appended transaction must not be re-processed, or the mark would be
  // reapplied on every keystroke forever.
  if (transactions.some((transaction) => transaction.getMeta(suggestionModeKey))) return null

  const markType = newState.schema.marks[INSERTION_MARK]
  if (!markType) return null

  const ranges: { from: number; to: number }[] = []
  for (const transaction of transactions) {
    for (const step of transaction.steps) {
      const map = step.getMap()
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        if (newEnd > newStart) ranges.push({ from: newStart, to: newEnd })
      })
    }
  }
  if (ranges.length === 0) return null

  const tracked = newState.tr
  const attrs = { authorId: mode.authorId, at: new Date().toISOString() }
  for (const range of ranges) {
    const from = Math.max(0, Math.min(range.from, newState.doc.content.size))
    const to = Math.max(from, Math.min(range.to, newState.doc.content.size))
    if (to > from) tracked.addMark(from, to, markType.create(attrs))
  }
  if (!tracked.docChanged && tracked.steps.length === 0) return null
  tracked.setMeta(suggestionModeKey, modeOf(newState))
  tracked.setMeta('addToHistory', false)
  return tracked
}

interface PlannedReplace {
  from: number
  to: number
  slice: Slice
}

/**
 * A rejected transaction's intent, in coordinates of `doc`, kept current by
 * `trackPending` until it can be replayed as a suggestion.
 */
export interface RewritePlan {
  mode: SuggestionOptions
  replaces: PlannedReplace[]
  mapping: Mapping
  doc: PmNode
}

/** Carry each pending plan through a transaction that landed before it was replayed. */
export function trackPending(plans: RewritePlan[], transaction: Transaction, newState: EditorState): void {
  for (const plan of plans) {
    plan.mapping.appendMapping(transaction.mapping)
    plan.doc = newState.doc
  }
}

/**
 * Turn a deletion into a proposal.
 *
 * `filterTransaction` is where this has to live because it is the only hook
 * that sees a deletion *before* the text is gone. A `null` plan lets the
 * transaction through untouched; otherwise the caller cancels it and replays
 * the plan with `applyPlan`. Inserted content is part of the plan, not just the
 * deletions: typing over a selection, Replace and paste-over-selection all
 * delete and insert in one step, and dropping the insertion would lose the
 * writer's new words.
 */
export function planRewrite(transaction: Transaction, state: EditorState): RewritePlan | null {
  const mode = modeOf(state)
  if (!mode.enabled || !mode.authorId) return null
  if (transaction.getMeta(suggestionModeKey)) return null
  if (!transaction.docChanged) return null
  const insertionType = state.schema.marks[INSERTION_MARK]
  if (!state.schema.marks[DELETION_MARK] || !insertionType) return null

  const replaces: PlannedReplace[] = []
  // Built by hand: `Mapping.invert` ignores a slice's bounds and would invert
  // every step, not just the ones before this one.
  const undoSoFar: StepMap[] = []
  transaction.steps.forEach((step) => {
    const back = new Mapping([...undoSoFar])
    undoSoFar.unshift(step.getMap().invert())
    if (step instanceof ReplaceStep) {
      const from = back.map(step.from, 1)
      replaces.push({ from, to: Math.max(from, back.map(step.to, -1)), slice: step.slice })
      return
    }
    step.getMap().forEach((oldStart, oldEnd) => {
      if (oldEnd <= oldStart) return
      const from = back.map(oldStart, 1)
      replaces.push({ from, to: Math.max(from, back.map(oldEnd, -1)), slice: Slice.empty })
    })
  })

  const deletesText = replaces.some(
    (replace) =>
      replace.to > replace.from &&
      classify(state.doc, replace, mode.authorId, insertionType.name).length > 0
  )
  if (!deletesText) return null
  return { mode, replaces, mapping: new Mapping(), doc: state.doc }
}

/**
 * Replay a plan against `state` as suggestions: this author's own pending
 * insertions are really removed, everything else is struck through, and new
 * content lands after the struck text carrying the insertion mark.
 */
export function applyPlan(plan: RewritePlan, state: EditorState): Transaction | null {
  const deletionType = state.schema.marks[DELETION_MARK]
  const insertionType = state.schema.marks[INSERTION_MARK]
  if (!deletionType || !insertionType) return null
  const { authorId } = plan.mode
  const at = new Date().toISOString()

  const rewritten = state.tr
  let cursor: number | null = null
  for (const replace of plan.replaces) {
    const from = plan.mapping.map(replace.from, 1)
    const to = Math.max(from, plan.mapping.map(replace.to, -1))

    if (to > from) {
      const range = { from: rewritten.mapping.map(from, 1), to: rewritten.mapping.map(to, -1) }
      const segments = classify(rewritten.doc, range, authorId, insertionType.name)
      const stepsBefore = rewritten.steps.length
      for (const segment of segments) {
        const local = rewritten.mapping.slice(stepsBefore)
        const segmentFrom = local.map(segment.from, 1)
        const segmentTo = local.map(segment.to, -1)
        if (segment.own) rewritten.delete(segmentFrom, segmentTo)
        else rewritten.addMark(segmentFrom, segmentTo, deletionType.create({ authorId, at }))
      }
    }

    if (replace.slice.size > 0) {
      const insertAt = rewritten.mapping.map(to, 1)
      const stepsBefore = rewritten.steps.length
      rewritten.replace(insertAt, insertAt, replace.slice)
      const local = rewritten.mapping.slice(stepsBefore)
      const insertedFrom = local.map(insertAt, -1)
      const insertedTo = local.map(insertAt, 1)
      if (insertedTo > insertedFrom) {
        rewritten.removeMark(insertedFrom, insertedTo, deletionType)
        rewritten.removeMark(insertedFrom, insertedTo, insertionType)
        rewritten.addMark(insertedFrom, insertedTo, insertionType.create({ authorId, at }))
        cursor = insertedTo
      }
    }
  }

  if (rewritten.steps.length === 0) return null
  if (cursor !== null) rewritten.setSelection(Selection.near(rewritten.doc.resolve(cursor), -1))
  rewritten.setMeta(suggestionModeKey, plan.mode)
  return rewritten
}

/**
 * Split a range into runs that are this author's own pending insertion and runs
 * that are not.
 *
 * The distinction is rule 3, and it is per-character rather than per-range
 * because a selection routinely spans both — someone rewrites a sentence they
 * partly wrote a moment ago.
 */
function classify(
  doc: PmNode,
  range: { from: number; to: number },
  authorId: string,
  insertionName: string
): { from: number; to: number; own: boolean }[] {
  const segments: { from: number; to: number; own: boolean }[] = []
  doc.nodesBetween(range.from, range.to, (node, position) => {
    if (!node.isText) return true
    const from = Math.max(range.from, position)
    const to = Math.min(range.to, position + node.nodeSize)
    if (to <= from) return false
    const own = node.marks.some(
      (mark) => mark.type.name === insertionName && mark.attrs.authorId === authorId
    )
    const previous = segments[segments.length - 1]
    if (previous && previous.own === own && previous.to === from) previous.to = to
    else segments.push({ from, to, own })
    return false
  })
  return segments
}
