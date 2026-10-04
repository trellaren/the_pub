import type { Editor } from '@tiptap/core'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { findPluginKey, getFindState, type FindOptions } from './extensions/findHighlight.js'
import { suggestionModeKey } from './extensions/suggestions.js'
import { resolveSuggestions, resolveSuggestionAt } from '@shared/pm/suggestions.js'
import type { PmDoc } from '@shared/model/document.js'
import { ANCHOR_MARK } from '@shared/model/anchor.js'

/** Start (or clear) a find. Matches are recomputed by the plugin. */
export function setFind(editor: Editor, options: FindOptions): void {
  const { state, view } = editor
  view.dispatch(state.tr.setMeta(findPluginKey, { options }))
}

export function clearFind(editor: Editor): void {
  setFind(editor, { term: '', matchCase: false, wholeWord: false })
}

/** Move to the next or previous match and scroll it into view. */
export function stepFind(editor: Editor, step: 1 | -1): void {
  const { state, view } = editor
  view.dispatch(state.tr.setMeta(findPluginKey, { step }))
  focusCurrentMatch(editor)
}

export function focusCurrentMatch(editor: Editor): void {
  const found = getFindState(editor.state)
  const match = found.matches[found.current]
  if (!match) return
  editor.chain().setTextSelection({ from: match.from, to: match.to }).scrollIntoView().run()
}

export function replaceCurrent(editor: Editor, replacement: string): boolean {
  const found = getFindState(editor.state)
  const match = found.matches[found.current]
  if (!match) return false
  // `insertText`, not `insertContentAt`: the latter parses its string as
  // HTML, so a replacement like `<b>` or `a & b` would not land as typed.
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.insertText(replacement, match.from, match.to)
      return true
    })
    .run()
  // The plugin recomputes matches and keeps the same index, which now points
  // at whatever followed — unless the replacement itself matches, in which
  // case it points back at the text just written. Either way, the next match
  // is the first one starting after the replacement.
  const after = match.from + replacement.length
  const remaining = getFindState(editor.state).matches
  const next = remaining.findIndex((candidate) => candidate.from >= after)
  const current = remaining.length === 0 ? -1 : next === -1 ? 0 : next
  editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { current }))
  focusCurrentMatch(editor)
  return true
}

export function replaceAll(editor: Editor, replacement: string): number {
  const found = getFindState(editor.state)
  if (found.matches.length === 0) return 0
  const { state, view } = editor
  const transaction = state.tr
  // Apply back to front so each replacement's positions are still valid when
  // the earlier ones have not yet shifted the document.
  for (let index = found.matches.length - 1; index >= 0; index--) {
    const match = found.matches[index]!
    transaction.insertText(replacement, match.from, match.to)
  }
  view.dispatch(transaction)
  return found.matches.length
}

/**
 * Scroll to a top-level block by index — the target a global search hit points
 * at — and optionally highlight the term that was searched for.
 */
export function revealBlock(editor: Editor, blockIndex: number, term?: string): void {
  let position: number | null = null
  editor.state.doc.forEach((_node, offset, index) => {
    if (index === blockIndex) position = offset
  })
  if (position === null) return
  editor
    .chain()
    .setTextSelection(position + 1)
    .scrollIntoView()
    .run()
  if (term) setFind(editor, { term, matchCase: false, wholeWord: false })
}

export function wordCount(editor: Editor): number {
  const storage = editor.storage.characterCount as { words?: () => number } | undefined
  return storage?.words?.() ?? 0
}

/**
 * Turn suggesting mode on or off for one editor.
 *
 * Through a transaction meta rather than by reconfiguring the extension: the
 * plugin's state has to change in step with the document's history, and
 * swapping the extension out would drop the undo stack under the writer.
 */
export function setSuggesting(editor: Editor, enabled: boolean, authorId: string): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(suggestionModeKey, { enabled: enabled && Boolean(authorId), authorId })
  )
}

/**
 * Take one anchor back off the text, wherever it now is — the selection it
 * was set on may have moved while the sidecar write was awaited.
 */
export function removeAnchor(editor: Editor, anchorId: string): void {
  const transaction = editor.state.tr
  editor.state.doc.descendants((node, position) => {
    for (const mark of node.marks) {
      if (mark.type.name === ANCHOR_MARK && mark.attrs.anchorId === anchorId) {
        transaction.removeMark(position, position + node.nodeSize, mark)
      }
    }
  })
  if (!transaction.docChanged) return
  // Through the suggesting-mode meta like `replaceDocument`: retracting an
  // anchor is not an edit anyone should be asked to review.
  transaction.setMeta(suggestionModeKey, suggestionModeKey.getState(editor.state) ?? { authorId: '', enabled: false })
  editor.view.dispatch(transaction)
}

/**
 * Accept or reject one suggestion.
 *
 * `index` is the suggestion's position in `listSuggestions` of the current
 * document. Goes through the same pure resolver module accept-all uses, then
 * replaces the document — rather than a bespoke range operation, which is how
 * the two paths drift apart.
 */
export function resolveSuggestion(editor: Editor, accept: boolean, index: number): void {
  replaceDocument(editor, resolveSuggestionAt(editor.getJSON() as PmDoc, accept, index))
}

/** Every pending suggestion in the document, judged at once. */
export function resolveAllSuggestions(editor: Editor, accept: boolean): void {
  replaceDocument(editor, resolveSuggestions(editor.getJSON() as PmDoc, accept))
}

/**
 * Swap the whole document for a JSON replacement, as one undoable step.
 *
 * Carries the suggesting-mode meta so the `SuggestingMode` filter lets it
 * through verbatim: the replacement already says exactly which marks it wants,
 * and a writer who is in suggesting mode while a verdict or an assistant edit
 * lands must not have that rewritten into a second layer of marks.
 */
export function replaceDocument(editor: Editor, doc: PmDoc): void {
  editor.view.dispatch(replaceDocumentTransaction(editor.state, doc))
}

/**
 * Only the span that actually differs is replaced. Replacing the whole
 * document would rebuild every node view, discard every decoration and throw
 * the selection to wherever clamping lands it; a narrow step leaves the rest
 * of the chapter — and the writer's cursor, mapped through it — alone.
 */
export function replaceDocumentTransaction(state: EditorState, doc: PmDoc): Transaction {
  const next = state.schema.nodeFromJSON(doc)
  const transaction = state.tr
  const start = state.doc.content.findDiffStart(next.content)
  if (start !== null) {
    let { a: endA, b: endB } = state.doc.content.findDiffEnd(next.content)!
    // When the differing text repeats around the change, the two scans can
    // cross; push both ends forward so the ranges are well-formed.
    const overlap = start - Math.min(endA, endB)
    if (overlap > 0) {
      endA += overlap
      endB += overlap
    }
    transaction.replace(start, endA, next.slice(start, endB))
    transaction.setSelection(state.selection.map(transaction.doc, transaction.mapping))
  }
  transaction.setMeta(suggestionModeKey, suggestionModeKey.getState(state) ?? { authorId: '', enabled: false })
  return transaction
}
