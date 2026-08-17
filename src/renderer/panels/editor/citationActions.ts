import type { Editor } from '@tiptap/core'
import { Fragment, type Node as PmProseNode } from '@tiptap/pm/model'
import type { PmDoc } from '@shared/model/document.js'
import type { CslItem } from '@shared/model/source.js'
import { FIELD_NODE } from '@shared/model/field.js'
import { FOOTNOTE_NODE } from '@shared/model/footnote.js'
import { listCitations, citedSourceIds } from '@shared/pm/citations.js'
import { findFieldRunRange } from '@shared/pm/fieldRuns.js'
import { positionsOf } from './fieldActions.js'
import {
  withEngine,
  isNoteStyle,
  type CiteprocEngine,
  type CitationCluster
} from '../../citations/citeprocEngine.js'

/** Placeholder text a fresh citation shows until the refresh that always follows fills in the real one. */
const PENDING_TEXT = '…'

/**
 * Whether `styleId`'s citations render inline (author-date, APA, MLA) or as
 * footnotes (Chicago notes-bibliography) — needed before insertion, so it has
 * to load the engine itself rather than waiting on a refresh.
 */
export async function citationPlacement(styleId: string): Promise<'inline' | 'note'> {
  const style = await withEngine(styleId, [], (engine) => (isNoteStyle(engine) ? 'note' : 'inline'))
  return style
}

/**
 * Insert a citation for `sourceIds` at the current selection, in a
 * note-style's own footnote or inline, per `placement`.
 *
 * Its text starts as a placeholder — every caller of this function follows it
 * with `refreshCitations`, which is the only thing allowed to write a
 * citation's real rendered text, for the same reason a table of contents
 * entry's text is never hand-typed (see `fieldActions.ts`).
 *
 * Built as one raw content tree via `insertContent`, not by chaining the
 * `insertFootnote`/`insertField` commands: those focus *inside* what they
 * insert (`insertFootnote` opens the note for typing into, which is right for
 * a person adding one by hand), and a citation's footnote has nothing for a
 * person to type — its entire content is the field. `insertContent`'s default
 * `updateSelection` lands the cursor right after the whole inserted tree, back
 * in the surrounding prose, which is what lets typing continue immediately
 * after citing a source in a note-style project.
 */
export function insertCitation(
  editor: Editor,
  sourceIds: string[],
  opts: { locator?: string; suppressAuthor?: boolean },
  placement: 'inline' | 'note'
): void {
  const field = {
    type: FIELD_NODE,
    attrs: {
      kind: 'citation',
      targetBlockId: null,
      level: null,
      sourceIds,
      locator: opts.locator ?? null,
      suppressAuthor: opts.suppressAuthor ?? false
    },
    content: [{ type: 'text', text: PENDING_TEXT }]
  }
  const content =
    placement === 'note' ? { type: FOOTNOTE_NODE, content: [{ type: 'paragraph', content: [field] }] } : field
  editor.chain().focus().insertContent(content).run()
}

/**
 * Cite a source from a highlight made inside one of its research
 * attachments (a PDF, per `docs/phase-11-plan.md` Part 2) — the join that
 * turns the research library into a library rather than a folder.
 *
 * Reuses `insertCitation` rather than growing separate insertion machinery:
 * the only thing a PDF highlight adds is a page number for the locator and,
 * optionally, the quoted text pasted as a block quote immediately above the
 * citation, in its own paragraph, so the two land as one thought in the
 * prose rather than a citation with a quote awkwardly inside its locator.
 */
export function citeFromPdfHighlight(
  editor: Editor,
  sourceId: string,
  highlight: { quote: string; page: number },
  placement: 'inline' | 'note',
  opts: { includeQuote?: boolean } = {}
): void {
  if (opts.includeQuote && highlight.quote) {
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: highlight.quote }] }]
      })
      .run()
  }
  insertCitation(editor, [sourceId], { locator: String(highlight.page) }, placement)
}

/**
 * Recompute every citation's rendered text in one pass, and return the
 * engine so a caller — `insertOrRefreshBibliography` — can reuse it rather
 * than reloading the same style a second time.
 *
 * citeproc is stateful across the whole document: `ibid.`, short forms and
 * disambiguating two same-author-same-year works all depend on what was
 * cited earlier. That is why this always walks every `citation` field in
 * document order and rebuilds the engine's state from scratch
 * (`rebuildProcessorState`) rather than rendering each field on its own —
 * rendering in isolation looks plausible and is wrong the moment a source is
 * cited twice.
 */
export async function refreshCitations(
  editor: Editor,
  sources: CslItem[],
  styleId: string
): Promise<CiteprocEngine | null> {
  const occurrences = listCitations(editor.getJSON() as PmDoc)
  if (occurrences.length === 0) {
    return withEngine(styleId, sources, (engine) => engine)
  }

  const clusters: CitationCluster[] = occurrences.map((occurrence, index) => ({
    citationID: `c${index}`,
    citationItems: (Array.isArray(occurrence.node.attrs?.sourceIds) ? occurrence.node.attrs.sourceIds : []).map(
      (id: unknown) => ({
        id: String(id),
        locator: (occurrence.node.attrs?.locator as string | undefined) ?? undefined,
        'suppress-author': (occurrence.node.attrs?.suppressAuthor as boolean | undefined) || undefined
      })
    ),
    properties: { noteIndex: occurrence.noteNumber ?? 0 }
  }))

  const [rendered, engine] = await withEngine(styleId, sources, (engine) => [
    engine.rebuildProcessorState(clusters, 'text'),
    engine
  ])

  applyCitationTexts(
    editor,
    rendered.map(([, , text]) => text)
  )
  return engine
}

/**
 * Write each rendered citation string into its field, live-doc positions and
 * all in one transaction — the same "two traversals must agree, or decline
 * rather than write to the wrong node" discipline `mentionActions.ts`'s
 * `markOccurrence` uses, because a live `Node` walk and the JSON walk that
 * produced `texts` are two independent implementations that happen to visit
 * the same nodes in the same order, not one.
 */
function applyCitationTexts(editor: Editor, texts: string[]): void {
  const positions: { pos: number; node: PmProseNode }[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === FIELD_NODE && node.attrs.kind === 'citation') positions.push({ pos, node })
  })
  if (positions.length !== texts.length) return

  const { state, view } = editor
  const tr = state.tr
  for (const [index, { pos, node }] of positions.entries()) {
    const text = texts[index] || PENDING_TEXT
    const mappedPos = tr.mapping.map(pos)
    const from = mappedPos + 1
    const to = mappedPos + node.nodeSize - 1
    tr.replaceWith(from, to, text ? state.schema.text(text) : Fragment.empty)
  }
  view.dispatch(tr)
}

/**
 * Create a bibliography, or bring an existing one up to date — the same
 * insert-or-refresh shape `insertOrRefreshTableOfContents` uses, for the same
 * reason: distinguishing "insert" from "refresh" at the toolbar would mean
 * exposing two buttons for one action.
 *
 * Takes the engine `refreshCitations` already built rather than loading its
 * own, so a full refresh — citations, then the bibliography they cite — pays
 * for one engine load, not two.
 */
export function insertOrRefreshBibliography(editor: Editor, sources: CslItem[], engine: CiteprocEngine): void {
  const cited = new Set(citedSourceIds(editor.getJSON() as PmDoc))
  const entries = sources.filter((source) => cited.has(source.id))
  engine.updateItems(entries.map((source) => source.id))
  engine.setOutputFormat('text')
  const result = engine.makeBibliography()

  const paragraphs = (result === false ? [] : result[1]).map((text) => ({
    type: 'paragraph',
    content: [
      {
        type: FIELD_NODE,
        attrs: { kind: 'bibliography' },
        // citeproc's plain-text format still wraps each entry, and a `field`'s
        // content is text-only — trailing whitespace from that wrapping would
        // otherwise show up as a stray blank line in the entry.
        content: text.trim() ? [{ type: 'text', text: text.trim() }] : []
      }
    ]
  }))
  const body = paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph', content: [] }]

  const existing = findFieldRunRange(editor.getJSON() as PmDoc, 'bibliography')
  if (existing) {
    const { from, to } = positionsOf(editor, existing.start, existing.end)
    editor.chain().focus().insertContentAt({ from, to }, body).run()
  } else {
    editor.chain().focus().insertContentAt(editor.state.doc.content.size, body).run()
  }
}
