import { Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { FIELD_NODE, type FieldKind } from '@shared/model/field.js'
import { revealBlock } from '../editorActions.js'

export interface FieldAttrsInput {
  kind: FieldKind
  targetBlockId?: string | null
  level?: number | null
  /** A `citation` field's sources, by id into the project's source library. */
  sourceIds?: string[]
  locator?: string
  suppressAuthor?: boolean
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    field: {
      /** Insert a field at the current selection, replacing it. */
      insertField: (attrs: FieldAttrsInput, text: string) => ReturnType
    }
  }
}

/**
 * Computed text embedded in the document: a cross-reference or a table-of-
 * contents entry.
 *
 * Its text child is real ProseMirror text, not just a `cachedText` attribute
 * rendered from JS — that is what lets `extractPlainText`, `countWords`,
 * search and DOCX export treat a field exactly like the prose around it, with
 * none of them needing to know a field exists (see `model/field.ts`). What
 * makes it a field rather than an ordinary marked run is that nothing but a
 * refresh command ever rewrites that text: `contenteditable="false"` on the
 * rendered element keeps a person from hand-editing text that the next
 * refresh would overwrite anyway.
 */
export const Field = Node.create({
  name: FIELD_NODE,
  group: 'inline',
  inline: true,
  content: 'text*',
  selectable: true,
  atom: false,

  addAttributes() {
    return {
      kind: { default: 'ref' },
      targetBlockId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-target-block-id'),
        renderHTML: (attributes) =>
          attributes.targetBlockId ? { 'data-target-block-id': attributes.targetBlockId } : {}
      },
      level: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute('data-level')
          return value ? Number(value) : null
        },
        renderHTML: (attributes) =>
          attributes.level != null ? { 'data-level': String(attributes.level) } : {}
      },
      sourceIds: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute('data-source-ids')
          return value ? value.split(',') : null
        },
        renderHTML: (attributes) =>
          attributes.sourceIds?.length ? { 'data-source-ids': attributes.sourceIds.join(',') } : {}
      },
      locator: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-locator'),
        renderHTML: (attributes) => (attributes.locator ? { 'data-locator': attributes.locator } : {})
      },
      suppressAuthor: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-suppress-author') === 'true',
        renderHTML: (attributes) => (attributes.suppressAuthor ? { 'data-suppress-author': 'true' } : {})
      }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-field]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    // A `toc` entry indents by its heading level; CSS `attr()` can't do this
    // arithmetic portably, so it's computed here instead.
    const level = node.attrs.kind === 'toc' && typeof node.attrs.level === 'number' ? node.attrs.level : null
    const style = level ? `padding-left: ${(level - 1) * 1.25}em` : undefined

    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'pub-field',
        'data-field': node.attrs.kind,
        contenteditable: 'false',
        ...(style ? { style } : {})
      }),
      0
    ]
  },

  addCommands() {
    return {
      insertField:
        (attrs, text) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              kind: attrs.kind,
              targetBlockId: attrs.targetBlockId ?? null,
              level: attrs.level ?? null,
              sourceIds: attrs.sourceIds?.length ? attrs.sourceIds : null,
              locator: attrs.locator ?? null,
              suppressAuthor: attrs.suppressAuthor ?? false
            },
            content: text ? [{ type: 'text', text }] : []
          })
    }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('fieldClick'),
        props: {
          // A field jumps to what it points at instead of placing a cursor in
          // its (non-editable) text — the same "click to go there" a search
          // hit or a beat's linked paragraph already offers.
          //
          // `pos` lands wherever inside the field the click did — often inside
          // its text child, not at the field node's own start — so this walks
          // the resolved position's ancestors rather than calling `nodeAt`,
          // which only matches a node's exact starting offset.
          handleClick(view, pos) {
            const $pos = view.state.doc.resolve(pos)
            let field = null
            for (let depth = $pos.depth; depth >= 0; depth--) {
              const node = $pos.node(depth)
              if (node.type.name === FIELD_NODE) {
                field = node
                break
              }
            }
            if (!field) return false
            const targetBlockId = field.attrs.targetBlockId as string | null
            if (!targetBlockId) return false
            let blockIndex = -1
            view.state.doc.forEach((child, _offset, index) => {
              if (child.attrs?.blockId === targetBlockId) blockIndex = index
            })
            if (blockIndex === -1) return false
            revealBlock(editor, blockIndex)
            return true
          }
        }
      })
    ]
  }
})
