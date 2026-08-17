import { Mark, mergeAttributes } from '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    lang: {
      /** Set the BCP-47 language of the selection, e.g. `fr` or `he`. */
      setLang: (lang: string) => ReturnType
      unsetLang: () => ReturnType
    }
  }
}

/**
 * Marks a passage as being in a different language than the document's own
 * — a quotation, a cited term, a whole cited paragraph. Exported as a run
 * property (`w:lang`) so Word spell-checks it correctly rather than against
 * the surrounding document's language; see `docs/phase-14-plan.md`.
 *
 * Deliberately excludes itself, the way `Anchors` does not but most marks
 * do: nesting a lang mark inside another lang mark has no meaning — the
 * innermost one simply wins on export — so allowing the overlap would only
 * invite an ambiguous document with no way to represent user intent.
 */
export const Lang = Mark.create({
  name: 'lang',
  inclusive: false,

  addAttributes() {
    return {
      lang: {
        default: null,
        parseHTML: (element) => element.getAttribute('lang'),
        renderHTML: (attributes) => (attributes.lang ? { lang: attributes.lang } : {})
      }
    }
  },

  parseHTML() {
    return [{ tag: 'span[lang]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setLang:
        (lang) =>
        ({ commands }) =>
          commands.setMark(this.name, { lang }),
      unsetLang:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name)
    }
  }
})
