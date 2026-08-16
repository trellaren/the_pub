# Phase 5 — Citations and bibliography

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 5. Depends on Phase 3 (shipped): Chicago's
notes-bibliography system renders citations *into footnotes*, and the `field` node is already the
right vehicle for a computed citation string. Depends on Phase 1 (shipped) for somewhere to put
the "which style" setting without inventing an IPC channel for it.

## Why CSL, and why in the renderer

Chicago alone has two systems (notes-bibliography and author-date) and hundreds of edge cases
around edited volumes, translations, repeat citations and `ibid.` Hand-rolling that is a
multi-month tax on a phase that is otherwise mostly plumbing. CSL styles are XML files maintained
by people who care about this more than we ever will, and `citeproc-js` is the reference
implementation.

citeproc runs in the **renderer**, not main, for three reasons that all point the same way:

1. It is a heavy dependency with a large style-file working set; the main process is the one that
   must stay responsive for file I/O and the search index.
2. The renderer is where the document lives, so a citation's computed text can be written into
   the document through the same editor command path as every other edit — no round trip, no
   partial-write window.
3. It makes export deterministic. Because the computed text is written into the document (see
   below), a `.pubdoc` exported on a machine that has never seen the style file still renders
   correctly — the same property that makes `field` work today.

## Part 1 — The source library

### `src/shared/model/source.ts` (new)

CSL-JSON, not a schema of our own invention. A hand-rolled bibliographic schema would have to be
translated into CSL-JSON for citeproc anyway, so store what the engine eats:

```ts
export const cslItemSchema = z.object({
  id: z.string(),
  type: z.string(),                       // CSL type: 'book', 'article-journal', 'chapter', …
  title: z.string().optional(),
  author: z.array(cslNameSchema).optional(),
  issued: cslDateSchema.optional(),
  // …plus a passthrough for the long tail
}).catchall(z.unknown())
```

The `.catchall` is deliberate and mirrors `pmNodeSchema`'s permissiveness (`src/shared/model/document.ts`):
CSL-JSON has ~60 fields and grows; rejecting a field we don't model would lose data on a BibTeX
import round-trip. Validation's job here is to confirm the envelope, not to police CSL.

### `src/main/services/sourceService.ts` (new)

Persists `.thepub/sources.json` — add `SOURCES_FILE` and `FORMAT_VERSIONS.sources: 1` to
`src/shared/constants.ts`, plus the (empty) `MIGRATIONS.sources` entry in
`src/shared/model/migrate.ts`.

### `src/main/services/jsonCollectionService.ts` (new) — the extraction

`EntityService`, `BeatService` and `MapService` are already three near-identical clones: private
`cache`, private `queue: Promise<void>` serialising writes, a constructor taking a `VfsAdapter`,
and `load()` / `snapshot()` / `get()` / `create()` / `save()` / `remove()` / private `flush()`,
with the same corrupt-file handling (`adapter.rename(FILE, FILE + '.corrupt-' + Date.now())`, then
reset to empty) in each. `sourceService.ts` would be the fourth. Extract the base *here*, where a
real fourth consumer forces the interface to be right, and retrofit the three:

```ts
abstract class JsonCollectionService<TItem, TFile> {
  constructor(adapter: VfsAdapter, opts: {
    file: string; kind: FileKind; schema: ZodType<TFile>;
    empty: () => TFile; items: (file: TFile) => TItem[]; idOf: (item: TItem) => string
  })
  load(): Promise<void>; snapshot(): TFile; get(id): TItem | undefined
  save(item: TItem): Promise<TItem>; remove(id: string): Promise<void>
  protected flush(): Promise<void>
}
```

The kind-specific bits stay on the subclasses — `EntityService.dismiss()`,
`BeatService.saveColumns()`/`deriveMoment()`, `MapService`'s cycle guard in `save()`. Retrofitting
the three existing services is part of this phase's diff, not a follow-up: an extraction that
leaves the originals in place has bought nothing.

### IPC

`sources:list` / `sources:save` / `sources:remove` / `sources:import`, added to
`src/shared/ipc/channels.ts` and `contract.ts` together (the `_InvokeChannelsMatch` guard catches
a mismatch), handled in `src/main/ipc/registerHandlers.ts` off `session.sources`.

## Part 2 — The `citation` field kind

`fieldKindSchema` in `src/shared/model/field.ts` is `z.enum(['ref', 'toc'])` today, and that file's
own comment already anticipates this phase: "every future computed-text kind (a citation,
eventually) is a consumer of the same node." Extend it:

```ts
export const fieldKindSchema = z.enum(['ref', 'toc', 'citation', 'bibliography'])
```

and extend `fieldAttrsSchema` with the citation payload:

```ts
sourceIds: z.array(z.string()).optional(),   // one citation may cite several sources
locator: z.string().optional(),               // "pp. 33–40"
suppressAuthor: z.boolean().optional()        // author-date's "(2019)" after a named author
```

The computed string stays where `field` already puts it: **a real text child of the node, not an
attribute.** That is what keeps `extractPlainText`, `countWords`, the search index and DOCX export
correct with no citation-shaped special case in any of them — the same property `ref` and `toc`
already rely on, and the reason `field` was built this way before a citation kind existed.

Adding a `field` *kind* is not a new node type, so `EDITOR_NODE_TYPES` in
`src/main/docx/toDocx.ts` and `INLINE_TYPES` in `src/shared/pm/extractText.ts` need no change and
the closed-world test in `toDocx.test.ts` stays green as-is. But the on-disk shape of a `field`
node's attrs *does* change, so bump `FORMAT_VERSIONS.document` (3 → 4) with a no-op step in
`MIGRATIONS.document`, matching the two steps Phase 3 already recorded there.

## Part 3 — Rendering: `citationActions.ts`

### `src/renderer/panels/editor/citationActions.ts` (new)

Modelled directly on `fieldActions.ts`, whose `insertOrRefreshTableOfContents(editor, styles)` is
already the shape this needs: find the existing computed region, recompute it from the document,
replace it in place, idempotently.

```ts
insertCitation(editor, sources: CslItem[], opts: { locator?: string })
refreshCitations(editor, sources: CslItem[], styleId: string): void
insertOrRefreshBibliography(editor, sources: CslItem[], styleId: string): void
```

`refreshCitations` is the one with real work in it. citeproc is stateful across a document —
`ibid.`, short forms and disambiguation all depend on what was cited earlier — so it must be
driven over the citations **in document order**, in one pass, and every `citation` field's text
replaced from that pass's output. Walking them individually and rendering each in isolation
produces plausible-looking output that is wrong the moment a source is cited twice.

For Chicago notes-bibliography, `insertCitation` inserts the `field` **inside a new `footnote`
node** rather than inline — that is Phase 3's node doing exactly the job it was built for, and the
reason this phase depends on that one. For author-date, the field goes inline. The branch is on
the CSL style's own declared class (`citeproc`'s `citeproc.opt.xclass` is `'note'` or
`'in-text'`), not on a hardcoded list of style names.

### Re-render triggers

Refresh on: a source edited or removed, the project's citation style changed, and document open.
Not on every keystroke — citeproc over a long document is not free, and the cached text in the
document is correct until a *source* changes, not until the prose does.

## Part 4 — The picker

Reuse `mention.ts`'s plumbing rather than rebuilding it. That file already instantiates
`@tiptap/suggestion`'s `Suggestion` inside `addProseMirrorPlugins()` with `{ char, items, command,
render }`, and its `renderPopup()` builds plain DOM off `props.editor.view.dom.ownerDocument`
specifically so it works in a popped-out window where `document` is a different object. A second
`Suggestion` instance with `char: '['`, `items` ranking sources by author/title/year (mirroring
`matchEntities`/`rankEntity`, capped the same way), and a `command` that calls `insertCitation`
gets the picker essentially for free, popout behaviour included.

## Part 5 — Styles, settings and import

### `resources/csl/`

Ships Chicago (both systems), MLA and APA. This uses the same `extraResources` packaging hook
Phase 4 adds for `resources/templates/` — if Phase 4 landed first, this is a second entry in the
same list; if not, this phase adds it. User-importable `.csl` into `userData/csl/` gives IEEE,
Harvard, Vancouver and a hundred journal styles for nothing.

### Settings

`citationStyleId` becomes a project-scoped setting through the Phase 1 registry — no new IPC
channel, which is precisely the payoff Phase 1 was pulled forward for.

### Import

BibTeX and RIS parsers live in **main**, as pure functions with no Electron import (following
`src/main/onedrive/`'s testability precedent), each returning `CslItem[]` for `sourceService` to
merge. DOI and ISBN lookup are network calls and belong in main too, behind
`sources:lookup`. Import is where the `.catchall` on `cslItemSchema` earns itself: a BibTeX file
carries fields we don't model and shouldn't drop.

## Verification

- `bash ci/run-checks.sh`.
- New unit tests: `jsonCollectionService` load/save/corrupt-rename, plus the existing
  entity/beat/map service tests still passing unchanged after the retrofit — that's the real proof
  the extraction was behaviour-preserving; BibTeX and RIS import against hand-written fixtures
  (real `.bib` output from Zotero and Mendeley, not our own exporter's — the same asymmetry rule
  `CLAUDE.md` states for DOCX import); `refreshCitations` producing `ibid.` for a repeated
  citation, which is the case a per-citation render gets wrong.
- New e2e test: insert two citations to the same source in Chicago notes-bibliography, confirm
  they land in footnotes and that the second renders as a short form; close and reopen the
  project and confirm the rendered text survives (a renderer-computed value that doesn't persist
  is the failure mode this phase is most exposed to).
- Manual: export a document with citations to `.docx` and open it in Word — the citations must be
  ordinary text in real footnotes, not fields Word will try to update.
