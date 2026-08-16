import { Mark, mergeAttributes, type Editor, type Range } from '@tiptap/core'
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import type { StoryEntity } from '@shared/model/entity.js'
import { MENTION_MARK } from '@shared/model/mention.js'

export interface MentionOptions {
  /** Live getter, so a record created a moment ago is offerable immediately. */
  getEntities: () => StoryEntity[]
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mention: {
      setMention: (attributes: { entityId: string; entityKind?: string }) => ReturnType
      unsetMention: () => ReturnType
    }
  }
}

/**
 * The link between prose and a story record.
 *
 * A **mark**, not a node: the name stays real text, so full-text search, word
 * count, snippets and DOCX export are all unaffected by whether a name happens
 * to be marked. The mark carries only ids, which is exactly why renaming a
 * record never has to touch a single document.
 *
 * `inclusive: false` keeps typing after a mention outside it, and
 * `keepOnSplit: false` stops a paragraph break from carrying it forward.
 */
export const Mention = Mark.create<MentionOptions>({
  name: MENTION_MARK,
  inclusive: false,
  keepOnSplit: false,
  excludes: MENTION_MARK,

  addOptions() {
    return { getEntities: () => [] }
  },

  addAttributes() {
    return {
      entityId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-entity-id'),
        renderHTML: (attributes) =>
          attributes.entityId ? { 'data-entity-id': attributes.entityId } : {}
      },
      entityKind: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-entity-kind'),
        renderHTML: (attributes) =>
          attributes.entityKind ? { 'data-entity-kind': attributes.entityKind } : {}
      }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-entity-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    // The colour comes from the generated stylesheet keyed on the id, not from
    // an inline style, so changing a record's colour restyles every open
    // document at once — and reaches popout windows, which share the sheet.
    return ['span', mergeAttributes(HTMLAttributes, { class: 'pub-mention' }), 0]
  },

  addCommands() {
    return {
      setMention:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(MENTION_MARK, attributes),
      unsetMention:
        () =>
        ({ commands }) =>
          commands.unsetMark(MENTION_MARK)
    }
  },

  addProseMirrorPlugins() {
    const getEntities = this.options.getEntities
    return [
      Suggestion({
        editor: this.editor,
        // Explicit and distinct from `Citation`'s `[` picker — see that
        // file's comment on why two `Suggestion` instances can't share a key.
        pluginKey: new PluginKey('mentionSuggestion'),
        char: '@',
        allowSpaces: true,
        items: ({ query }) => matchEntities(getEntities(), query),
        command: ({ editor, range, props }) => insertMention(editor, range, props as StoryEntity),
        render: renderPopup
      })
    ]
  }
})

export function matchEntities(entities: StoryEntity[], query: string): StoryEntity[] {
  const needle = query.trim().toLowerCase()
  const scored = entities
    .map((entity) => ({ entity, rank: rankEntity(entity, needle) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.entity.name.localeCompare(b.entity.name))
  return scored.slice(0, 8).map((candidate) => candidate.entity)
}

function rankEntity(entity: StoryEntity, needle: string): number {
  if (!needle) return 1
  const forms = [entity.name, ...entity.aliases.map((alias) => alias.text)]
  let best = -1
  for (const form of forms) {
    const lower = form.toLowerCase()
    // A prefix match ranks above a match in the middle of the name.
    const rank = lower.startsWith(needle) ? 0 : lower.includes(needle) ? 2 : -1
    if (rank >= 0 && (best === -1 || rank < best)) best = rank
  }
  return best
}

/**
 * Replace the typed `@query` with the record's name, marked.
 *
 * The `@` itself is not kept: the prose should read as prose. A trailing space
 * is inserted *outside* the mark so that continuing to type does not extend it.
 */
function insertMention(editor: Editor, range: Range, entity: StoryEntity): void {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      {
        type: 'text',
        text: entity.name,
        marks: [{ type: MENTION_MARK, attrs: { entityId: entity.id, entityKind: entity.kind } }]
      },
      { type: 'text', text: ' ' }
    ])
    .run()
}

/**
 * The autocomplete popup, built as plain DOM rather than React.
 *
 * `Suggestion`'s render hooks run inside a ProseMirror plugin, where there is
 * no React context to mount into; and an editor torn out into a popout window
 * has a *different* `document`, so a popup mounted from the main window's React
 * tree would appear in the wrong window entirely. Building against
 * `view.dom.ownerDocument` is what makes it appear next to the caret in
 * whichever window that caret is in. Tailwind classes still apply because
 * dockview copies the stylesheets into popouts.
 */
function renderPopup() {
  let element: HTMLDivElement | null = null
  let items: StoryEntity[] = []
  let selected = 0
  let pick: ((entity: StoryEntity) => void) | null = null

  const draw = (): void => {
    if (!element) return
    element.replaceChildren()
    items.forEach((entity, index) => {
      const button = element!.ownerDocument.createElement('button')
      button.type = 'button'
      button.className = [
        'flex w-full items-center gap-2 px-2 py-1 text-left text-[12px]',
        index === selected ? 'bg-surface-3 text-text' : 'text-muted'
      ].join(' ')
      const dot = element!.ownerDocument.createElement('span')
      dot.className = 'h-2 w-2 shrink-0 rounded-full'
      dot.style.background = entity.color ?? 'transparent'
      button.append(dot, element!.ownerDocument.createTextNode(entity.name))
      // mousedown, not click: the editor loses focus before click fires.
      button.addEventListener('mousedown', (event) => {
        event.preventDefault()
        pick?.(entity)
      })
      element!.append(button)
    })
  }

  const place = (props: SuggestionProps<StoryEntity>): void => {
    if (!element) return
    const rect = props.clientRect?.()
    if (!rect) return
    element.style.left = `${Math.round(rect.left)}px`
    element.style.top = `${Math.round(rect.bottom + 4)}px`
  }

  return {
    onStart: (props: SuggestionProps<StoryEntity>) => {
      const ownerDocument = props.editor.view.dom.ownerDocument
      element = ownerDocument.createElement('div')
      element.className =
        'pub-mention-popup fixed z-50 min-w-40 overflow-hidden rounded border border-border bg-surface-2 py-1 shadow-lg'
      element.dataset.testid = 'mention-popup'
      ownerDocument.body.append(element)
      items = props.items
      selected = 0
      pick = (entity) => props.command(entity)
      draw()
      place(props)
    },

    onUpdate: (props: SuggestionProps<StoryEntity>) => {
      items = props.items
      selected = 0
      pick = (entity) => props.command(entity)
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

/** Colours for every record, delivered the same way named styles are. */
export function generateMentionStyleSheet(entities: StoryEntity[]): string {
  const rules = entities
    .filter((entity) => entity.color)
    .map(
      (entity) =>
        `.pub-mention[data-entity-id="${entity.id}"] { --pub-mention-color: ${entity.color}; }`
    )
  return [
    '.pub-mention { border-bottom: 1px dotted var(--pub-mention-color, var(--color-accent)); }',
    ...rules
  ].join('\n')
}
