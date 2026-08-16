/**
 * A footnote: block content — one or more paragraphs — anchored inline at the
 * point in the text it annotates.
 *
 * Unlike `field` (whose text is what a reader sees inline), a footnote's own
 * content is *not* meant to be read as part of the sentence it sits in — only
 * its marker is. That is why it is excluded from a block's flowing text in
 * `extractText.ts` rather than folded in the way a field's cached text is.
 *
 * No attributes, and no id: numbering is never stored, only computed from
 * document order (see `pm/footnotes.ts`), and the note's content lives
 * directly inside the node rather than being addressed indirectly — so
 * deleting the marker deletes the note, and cut/paste carries both together.
 */
export const FOOTNOTE_NODE = 'footnote'
