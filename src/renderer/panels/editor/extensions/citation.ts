import { Extension, type Editor, type Range } from '@tiptap/core'
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import type { CslItem } from '@shared/model/source.js'
import { authorNames, issuedYear, describeSource } from '@shared/model/source.js'
import { insertCitation, refreshCitations, citationPlacement } from '../citationActions.js'

export interface CitationOptions {
  /** Live getter, so a source added a moment ago is citable immediately — same reasoning as `Mention`'s `getEntities`. */
  getSources: () => CslItem[]
  getStyleId: () => string
}

/**
 * The `[` picker for citing a source, built on the same `@tiptap/suggestion`
 * plumbing `Mention` uses — see that file's comment on why the popup is
 * plain DOM rather than React (it has to work in a popped-out window with a
 * different `document`).
 *
 * An extension, not a mark or node: a citation is a `field`, already
 * registered by `extensions/field.ts`. This only supplies the trigger.
 *
 * One source per invocation. `field`'s `sourceIds` can hold several — a
 * single parenthetical citing more than one work — but building a picker
 * that also handles that grouping is real UI, not just plumbing, and
 * nothing needs it yet: re-invoking the picker inserts a second, separate
 * citation, which is correct, just not merged into one parenthetical.
 */
export const Citation = Extension.create<CitationOptions>({
  name: 'citationPicker',

  addOptions() {
    return { getSources: () => [], getStyleId: () => 'chicago-author-date' }
  },

  addProseMirrorPlugins() {
    const getSources = this.options.getSources
    const getStyleId = this.options.getStyleId
    return [
      Suggestion({
        editor: this.editor,
        // `@tiptap/suggestion` keys its plugin `'suggestion$'` unless told
        // otherwise, and ProseMirror rejects two distinct plugin instances
        // sharing one key — `Mention`'s `@` picker is the other `Suggestion`
        // this editor registers, so both need their own key.
        pluginKey: new PluginKey('citationSuggestion'),
        char: '[',
        allowSpaces: true,
        items: ({ query }) => matchSources(getSources(), query),
        command: ({ editor, range, props }) =>
          void pickCitation(editor, range, props as CslItem, getSources(), getStyleId()),
        render: renderPopup
      })
    ]
  }
})

export function matchSources(sources: CslItem[], query: string): CslItem[] {
  const needle = query.trim().toLowerCase()
  const scored = sources
    .map((source) => ({ source, rank: rankSource(source, needle) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((a, b) => a.rank - b.rank || describeSource(a.source).localeCompare(describeSource(b.source)))
  return scored.slice(0, 8).map((candidate) => candidate.source)
}

function rankSource(source: CslItem, needle: string): number {
  if (!needle) return 1
  const forms = [authorNames(source), source.title ?? '', issuedYear(source) ?? '']
  let best = -1
  for (const form of forms) {
    const lower = form.toLowerCase()
    const rank = lower.startsWith(needle) ? 0 : lower.includes(needle) ? 2 : -1
    if (rank >= 0 && (best === -1 || rank < best)) best = rank
  }
  return best
}

/**
 * Replace the typed `[query` with a citation field, then recompute every
 * citation in the document — never just this one, for the reason
 * `refreshCitations` documents.
 */
async function pickCitation(
  editor: Editor,
  range: Range,
  source: CslItem,
  sources: CslItem[],
  styleId: string
): Promise<void> {
  // The `[` and typed query are removed by the same transaction that inserts
  // the field, matching `insertMention`'s "the trigger character is not kept".
  editor.chain().focus().deleteRange(range).run()
  const placement = await citationPlacement(styleId)
  insertCitation(editor, [source.id], {}, placement)
  await refreshCitations(editor, sources, styleId)
}

/** The autocomplete popup — see `mention.ts`'s `renderPopup` for why this is plain DOM. */
function renderPopup() {
  let element: HTMLDivElement | null = null
  let items: CslItem[] = []
  let selected = 0
  let pick: ((source: CslItem) => void) | null = null

  const draw = (): void => {
    if (!element) return
    element.replaceChildren()
    items.forEach((source, index) => {
      const button = element!.ownerDocument.createElement('button')
      button.type = 'button'
      button.className = [
        'flex w-full flex-col items-start px-2 py-1 text-left text-[12px]',
        index === selected ? 'bg-surface-3 text-text' : 'text-muted'
      ].join(' ')
      button.append(element!.ownerDocument.createTextNode(describeSource(source) || '(untitled)'))
      button.addEventListener('mousedown', (event) => {
        event.preventDefault()
        pick?.(source)
      })
      element!.append(button)
    })
    if (items.length === 0) {
      const empty = element.ownerDocument.createElement('div')
      empty.className = 'px-2 py-1 text-[12px] text-faint'
      empty.textContent = 'No matching sources'
      element.append(empty)
    }
  }

  const place = (props: SuggestionProps<CslItem>): void => {
    if (!element) return
    const rect = props.clientRect?.()
    if (!rect) return
    element.style.left = `${Math.round(rect.left)}px`
    element.style.top = `${Math.round(rect.bottom + 4)}px`
  }

  return {
    onStart: (props: SuggestionProps<CslItem>) => {
      const ownerDocument = props.editor.view.dom.ownerDocument
      element = ownerDocument.createElement('div')
      element.className =
        'pub-citation-popup fixed z-50 min-w-52 max-w-80 overflow-hidden rounded border border-border bg-surface-2 py-1 shadow-lg'
      element.dataset.testid = 'citation-popup'
      ownerDocument.body.append(element)
      items = props.items
      selected = 0
      pick = (source) => props.command(source)
      draw()
      place(props)
    },

    onUpdate: (props: SuggestionProps<CslItem>) => {
      items = props.items
      selected = 0
      pick = (source) => props.command(source)
      draw()
      place(props)
    },

    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (!element || items.length === 0) return false
      if (event.key === 'ArrowDown') {
        selected = (selected + 1) % items.length
        draw()
        return true
      }
      if (event.key === 'ArrowUp') {
        selected = (selected - 1 + items.length) % items.length
        draw()
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        pick?.(items[selected]!)
        return true
      }
      if (event.key === 'Escape') {
        element.remove()
        element = null
        return true
      }
      return false
    },

    onExit: () => {
      element?.remove()
      element = null
      items = []
    }
  }
}
