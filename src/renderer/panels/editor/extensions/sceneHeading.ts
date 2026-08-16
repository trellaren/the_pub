import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { StoryEntity } from '@shared/model/entity.js'
import { STYLE_SCENE_HEADING } from '@shared/model/style.js'

export interface SceneHeadingOptions {
  /** Live getter, same reasoning as `Mention`'s `getEntities` — a location
   *  added a moment ago is offerable in the very next scene heading. Already
   *  filtered to the project's location kind by the caller, the same way
   *  `Citation`'s `getSources` arrives pre-filtered to citable sources. */
  getLocations: () => StoryEntity[]
}

const sceneHeadingKey = new PluginKey('sceneHeadingSuggestion')

/**
 * Offers a location while the caret sits in a Scene Heading line — triggered
 * by the block's own style rather than a character, which is why this is a
 * plain ProseMirror plugin instead of another `@tiptap/suggestion` instance
 * like `Mention` and `Citation`: `Suggestion`'s matcher is built around a
 * literal trigger character with no "no character, match by node type" mode.
 *
 * The popup itself still follows `mention.ts`'s plain-DOM pattern — built
 * against `view.dom.ownerDocument` so it works in a torn-out window too.
 */
export const SceneHeading = Extension.create<SceneHeadingOptions>({
  name: 'sceneHeadingSuggestion',

  addOptions() {
    return { getLocations: () => [] }
  },

  addProseMirrorPlugins() {
    const getLocations = this.options.getLocations
    let popup: Popup | null = null

    return [
      new Plugin({
        key: sceneHeadingKey,
        view(_editorView) {
          return {
            update(view) {
              const match = sceneHeadingMatch(view)
              if (!match) {
                popup?.hide()
                return
              }
              const items = matchLocations(getLocations(), match.query)
              if (!popup) popup = createPopup(view)
              popup.show(items, match.range)
            },
            destroy() {
              popup?.hide()
              popup = null
            }
          }
        },
        props: {
          handleKeyDown(_view, event) {
            return popup?.visible ? popup.onKeyDown(event) : false
          }
        }
      })
    ]
  }
})

interface SceneHeadingMatch {
  query: string
  range: { from: number; to: number }
}

/**
 * Whether the caret sits in a Scene Heading paragraph, and if so, the word
 * currently being typed (from the last space, or the line's start) and its
 * range in document coordinates — what gets replaced when a location is
 * picked, the same "replace what was typed" shape `insertMention` uses.
 */
function sceneHeadingMatch(view: EditorView): SceneHeadingMatch | null {
  const { $from, empty } = view.state.selection
  if (!empty) return null
  if ($from.parent.attrs.styleId !== STYLE_SCENE_HEADING) return null
  const text = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const wordStart = text.lastIndexOf(' ') + 1
  return { query: text.slice(wordStart), range: { from: $from.pos - (text.length - wordStart), to: $from.pos } }
}

function matchLocations(locations: StoryEntity[], query: string): StoryEntity[] {
  const needle = query.trim().toLowerCase()
  const scored = locations
    .map((location) => ({ location, rank: rankLocation(location, needle) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.location.name.localeCompare(b.location.name))
  return scored.slice(0, 8).map((candidate) => candidate.location)
}

function rankLocation(location: StoryEntity, needle: string): number {
  if (!needle) return 1
  const forms = [location.name, ...location.aliases.map((alias) => alias.text)]
  let best = -1
  for (const form of forms) {
    const lower = form.toLowerCase()
    const rank = lower.startsWith(needle) ? 0 : lower.includes(needle) ? 2 : -1
    if (rank >= 0 && (best === -1 || rank < best)) best = rank
  }
  return best
}

/** Replace the typed word with the location's name — mirrors `insertMention`. */
function pickLocation(view: EditorView, range: { from: number; to: number }, location: StoryEntity): void {
  view.dispatch(view.state.tr.insertText(`${location.name} `, range.from, range.to))
  view.focus()
}

interface Popup {
  visible: boolean
  show: (items: StoryEntity[], range: { from: number; to: number }) => void
  hide: () => void
  onKeyDown: (event: KeyboardEvent) => boolean
}

/** See `mention.ts`'s `renderPopup` for why this is plain DOM, not React. */
function createPopup(view: EditorView): Popup {
  const ownerDocument = view.dom.ownerDocument
  const element = ownerDocument.createElement('div')
  element.className =
    'pub-scene-heading-popup fixed z-50 min-w-40 overflow-hidden rounded border border-border bg-surface-2 py-1 shadow-lg'
  element.dataset.testid = 'scene-heading-popup'
  element.style.display = 'none'
  ownerDocument.body.append(element)

  let items: StoryEntity[] = []
  let selected = 0
  let range: { from: number; to: number } = { from: 0, to: 0 }
  const state: Popup = {
    visible: false,
    show: (nextItems, nextRange) => {
      items = nextItems
      range = nextRange
      selected = Math.min(selected, Math.max(items.length - 1, 0))
      state.visible = true
      draw()
      place()
    },
    hide: () => {
      if (!state.visible) return
      state.visible = false
      element.style.display = 'none'
    },
    onKeyDown: (event) => {
      if (items.length === 0) return false
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
        pickLocation(view, range, items[selected]!)
        return true
      }
      if (event.key === 'Escape') {
        state.hide()
        return true
      }
      return false
    }
  }

  function draw(): void {
    if (!state.visible) return
    element.style.display = items.length > 0 ? 'block' : 'none'
    element.replaceChildren()
    items.forEach((location, index) => {
      const button = ownerDocument.createElement('button')
      button.type = 'button'
      button.className = [
        'flex w-full items-center gap-2 px-2 py-1 text-left text-[12px]',
        index === selected ? 'bg-surface-3 text-text' : 'text-muted'
      ].join(' ')
      button.append(ownerDocument.createTextNode(location.name))
      button.addEventListener('mousedown', (event) => {
        event.preventDefault()
        pickLocation(view, range, location)
      })
      element.append(button)
    })
  }

  function place(): void {
    if (!state.visible) return
    const coords = view.coordsAtPos(range.to)
    element.style.left = `${Math.round(coords.left)}px`
    element.style.top = `${Math.round(coords.bottom + 4)}px`
  }

  return state
}
