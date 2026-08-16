import { Mark, Extension, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, type Transaction, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { INSERTION_MARK, DELETION_MARK } from '@shared/model/suggestion.js'
import { colorForAuthor } from '@shared/model/author.js'

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
    return ['ins', mergeAttributes(HTMLAttributes, { class: 'pub-insertion' }, tint(mark.attrs)), 0]
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
    return ['del', mergeAttributes(HTMLAttributes, { class: 'pub-deletion' }, tint(mark.attrs)), 0]
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

    return [
      new Plugin<SuggestionOptions>({
        key: suggestionModeKey,
        state: {
          init: () => ({ ...options }),
          apply: (transaction, value) => {
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
        filterTransaction: (transaction, state) =>
          allowOrRewrite(transaction, state, (replacement) => {
            // Deferred, because dispatching from inside a filter re-enters it.
            queueMicrotask(() => view?.dispatch(replacement))
          })
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

/**
 * Turn a deletion into a proposal.
 *
 * Returning `false` cancels the transaction; the replacement is dispatched in
 * its place. `filterTransaction` is where this has to live because it is the
 * only hook that sees a deletion *before* the text is gone.
 */
function allowOrRewrite(
  transaction: Transaction,
  state: EditorState,
  dispatch: (replacement: Transaction) => void
): boolean {
  const mode = modeOf(state)
  if (!mode.enabled || !mode.authorId) return true
  if (transaction.getMeta(suggestionModeKey)) return true
  if (!transaction.docChanged) return true

  const deletions = deletedRanges(transaction)
  if (deletions.length === 0) return true

  const deletionType = state.schema.marks[DELETION_MARK]
  const insertionType = state.schema.marks[INSERTION_MARK]
  if (!deletionType || !insertionType) return true

  const rewritten = state.tr
  let rewroteSomething = false

  for (const range of deletions) {
    // Walk the doomed range and split it: text that is this author's own
    // pending insertion is really removed, everything else is struck through.
    const segments = classify(state, range, mode.authorId, insertionType.name)
    for (const segment of segments) {
      if (segment.own) {
        rewritten.delete(rewritten.mapping.map(segment.from), rewritten.mapping.map(segment.to))
      } else {
        rewritten.addMark(
          rewritten.mapping.map(segment.from),
          rewritten.mapping.map(segment.to),
          deletionType.create({ authorId: mode.authorId, at: new Date().toISOString() })
        )
      }
      rewroteSomething = true
    }
  }

  if (!rewroteSomething) return true
  rewritten.setMeta(suggestionModeKey, mode)
  dispatch(rewritten)
  return false
}

/** Ranges this transaction would remove, in the document as it stands now. */
function deletedRanges(transaction: Transaction): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = []
  for (const step of transaction.steps) {
    step.getMap().forEach((oldStart, oldEnd) => {
      if (oldEnd > oldStart) ranges.push({ from: oldStart, to: oldEnd })
    })
  }
  return ranges
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
  state: EditorState,
  range: { from: number; to: number },
  authorId: string,
  insertionName: string
): { from: number; to: number; own: boolean }[] {
  const segments: { from: number; to: number; own: boolean }[] = []
  state.doc.nodesBetween(range.from, range.to, (node, position) => {
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
