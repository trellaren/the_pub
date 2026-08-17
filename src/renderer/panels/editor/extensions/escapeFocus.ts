import { Extension } from '@tiptap/core'

/**
 * Tab is claimed inside the editor — `namedStyles.ts` cycles a screenplay
 * style with it, so it cannot double as "leave the editor" or a writer using
 * a stylable paragraph could never tab to the toolbar or anywhere else by
 * keyboard. Escape moving focus out first is the documented way around that
 * (Part 1 of `docs/phase-14-plan.md`): press Escape, then Tab leaves like any
 * other focusable region.
 *
 * Popup key handling (mention/citation/scene-heading suggestions, the
 * footnote popover) consumes its own Escape while open and returns early, so
 * this only ever fires once nothing above it has already handled the key.
 */
export const EscapeFocus = Extension.create({
  name: 'escapeFocus',

  addKeyboardShortcuts() {
    return {
      Escape: () => {
        const dom = this.editor.view.dom as HTMLElement
        dom.blur()
        return true
      }
    }
  }
})
