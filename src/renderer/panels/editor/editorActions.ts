import type { Editor } from '@tiptap/core'
import { findPluginKey, getFindState, type FindOptions } from './extensions/findHighlight.js'
import { suggestionModeKey } from './extensions/suggestions.js'
import { resolveSuggestions } from '@shared/pm/suggestions.js'
import type { PmDoc } from '@shared/model/document.js'

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
  editor
    .chain()
    .focus()
    .insertContentAt({ from: match.from, to: match.to }, replacement)
    .run()
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
 * Accept or reject one suggestion.
 *
 * Goes through the same pure resolver the Word importer and accept-all use,
 * filtered down to this author and kind, then replaces the document — rather
 * than a bespoke range operation, which is how the two paths drift apart.
 */
export function resolveSuggestion(
  editor: Editor,
  accept: boolean,
  suggestion: { mark: 'insertion' | 'deletion'; authorId: string }
): void {
  const resolved = resolveSuggestions(editor.getJSON() as PmDoc, accept, {
    authorId: suggestion.authorId,
    mark: suggestion.mark
  })
  editor.commands.setContent(resolved)
}

/** Every pending suggestion in the document, judged at once. */
export function resolveAllSuggestions(editor: Editor, accept: boolean): void {
  editor.commands.setContent(resolveSuggestions(editor.getJSON() as PmDoc, accept))
}
