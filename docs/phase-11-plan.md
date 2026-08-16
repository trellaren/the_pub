# Phase 11 — Highlighting and the research library

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 11. Depends on Phase 0 (shipped) for
anchor-style text recovery and on Phase 5 (shipped) for the CSL source library this extends.

Two halves of one activity. A writer marks a passage because it matters — in their own draft, or
in something they are reading — and later wants every passage they marked, together, with the
citation attached. Today the app can do neither: `Highlight` is loaded in `createEditor.ts` as
pure yellow text, and a source in `sources.json` is a bibliographic record with nothing behind it
to read.

## Part 1 — A highlight that means something

### The decision: one mark, an id allocated lazily

`highlight` is already in the editor schema and already in `EDITOR_MARK_TYPES`
(`src/main/docx/toDocx.ts`). Phase 11 does **not** add a second mark beside it, and does not
route highlights through the `anchor` mark either. It extends the existing one:

```ts
// addAttributes() on the Highlight extension
highlightId: { default: null }     // a ULID, only when the highlight is collected
```

Absent, it is yellow text, exactly as today and in every existing document. Present, it is a
record in a sidecar with a category, an optional note, and orphan recovery. This is Phase 0's
`blockId` reasoning applied to a mark: **allocate identity only to what something points at**,
because stamping every casual highlight would put a ULID in the `.pubdoc` for a colour someone
swiped on and forgot.

Two colliding designs were considered and rejected. A separate `researchHighlight` mark means two
marks fighting over one range and two things for the toolbar to toggle. Reusing `anchor` conflates
"a range something is attached to" with "a range the writer coloured" — a note and a highlight
have different lifetimes, and Phase 2 deliberately keeps note bodies out of the document.

The attribute changes the on-disk shape of a mark, so `FORMAT_VERSIONS.document` bumps with a
no-op `MIGRATIONS.document` step, for the reason the four steps already in that list record.

### `.thepub/highlights/<docId>.json`

One file per document — Phase 2's notes layout, for Phase 2's reasons (a small remote write, no
cross-document conflict). Per-author splitting is deliberately *not* adopted from Phase 9:
a highlight is a private reading act, and if Phase 9 has shipped, `authorId` on the record plus
one file per document is enough, since collisions need two people highlighting the same document
at the same moment.

```ts
export const highlightSchema = z.object({
  id: z.string(), docId: z.string(), highlightId: z.string(),
  color: z.string(),                    // the mark's own colour, mirrored for the panel
  categoryId: z.string().default(''),   // project-defined; see below
  note: z.string().default(''),
  authorId: z.string().default(''),
  quote: z.string(),                    // the highlighted text, for recovery and for the panel
  blockIndex: z.number().int(),
  orphaned: z.boolean().default(false),
  created: z.string(), modified: z.string()
})
```

`quote` + `blockIndex` + text-based re-finding is `noteService`'s reconcile, and it reuses
`shared/pm/anchors.ts`'s machinery over `extractText.ts`'s normalised offsets rather than growing
a second recovery implementation. A highlight whose text is gone becomes orphaned, never deleted.

**Categories** (`Evidence`, `Quote to use`, `Check this`, `Voice`) are project-scoped, defined on
the manifest beside `entityKinds` — the Phase 6 mechanism for vocabulary that differs between a
novel and a thesis — each with a colour, so choosing a category *is* choosing the highlight
colour and the two can never disagree.

### Export

DOCX already emits `highlight` as `w:highlight`; the id is dropped on the way out, which is
correct — a Word reader has no use for it. A note on a highlight exports as a Word comment when
Phase 9's comment plumbing exists, and is omitted otherwise rather than invented as bracketed
text in the prose.

## Part 2 — The research library

### Attachments live beside the source

Phase 5 put CSL-JSON in `.thepub/sources.json` and stopped at the metadata. A source gains
attachments stored through the `VfsAdapter` — which is the whole reason a research library works
on SFTP and OneDrive without a line of backend-specific code:

```
.thepub/research/<sourceId>/<attachmentId>.pdf
.thepub/research/<sourceId>/<attachmentId>.capture.json
```

with the index in `sources.json` itself. `cslItemSchema` has a `.catchall`, so the attachment
list rides in a namespaced key (`_pubAttachments`) that BibTeX round-trips ignore and citeproc
never sees — the escape hatch that `.catchall` was written for.

**Never in the project's own folder tree.** A 40 MB PDF in the manuscript directory would be
walked by the search indexer, shown in the file tree, and swept into a Word export's asset scan.
`.thepub/` is already the line this codebase draws for app-managed data.

### Reading a PDF in the app

`pdf.js` in the renderer, with **the worker bundled locally** — the CSP in `src/main/index.ts` is
`connect-src 'self' data:` in production, and a CDN worker would simply not load. Rendering to
canvas plus the text layer; the text layer is what makes selection, and therefore highlighting,
possible at all.

A PDF highlight anchors by **the quoted text first, page and rectangles second**. Page
coordinates are exact and brittle — they break the moment a source is replaced with a different
scan of the same paper — and quoted text is what survives. This is the same ordering the document
highlights use, and it is not a coincidence: it is the one recovery strategy this codebase
already trusts.

### Web capture

Fetching belongs in main (`src/main/research/capture.ts`), as pure logic with `fetch` injected,
following `src/main/onedrive/`. It stores the readable text, the title, the URL and the retrieval
date — and writes `accessed` and `URL` straight into the CSL item, because those are fields
citeproc already renders and a "captured on" date the bibliography cannot see is a date that does
not exist.

No screenshotting, no full-page archive: the deliverable is quotable text with a citable date.

### Citing a highlight

The join that makes this a library rather than a folder. From a highlight in a PDF, one command
inserts a Phase 5 `citation` field for its source with the locator prefilled from the page — and
optionally pastes the quoted text as a block quote above it. That is `insertCitation` from
`citationActions.ts` called with a locator, not new machinery.

## Part 3 — The Research panel

A dock panel, not a modal — popout and layout persistence for free, and this is a panel someone
keeps open beside the editor for hours.

Two tabs over one list model: **Manuscript** (highlights in the writer's own documents) and
**Sources** (highlights in attachments), filterable by category, colour, source and orphan
status, searchable over `quote` and `note`. Clicking jumps — to a document range through the same
resolved-position path the search and notes panels use, or to a page in the PDF reader.

An orphaned-highlights section, like the notes panel's, because a highlight that quietly stopped
matching anything is the failure mode a reader only discovers when they need the quote.

## Deliberately out of scope

OCR of scanned PDFs; annotating anything but PDFs and captures (no EPUB or DjVu reader); editing
or re-saving a PDF; full-page web archiving; and Zotero/Mendeley *sync* — Phase 5's BibTeX and
RIS import already move the metadata, and two-way sync is a different product.

## Verification

- `bash ci/run-checks.sh`.
- Unit: `highlightId` allocated only on collect and never on a plain colour toggle; de-duplication
  when a highlighted range is split or pasted; reconcile finding a highlight after edits before,
  inside and after it, and orphaning it when the quote is gone; category/colour agreement;
  attachment paths resolving under `.thepub/research/`; capture writing `accessed` and `URL` into
  the CSL item; PDF quote-first anchoring preferred over stored rectangles when both are present
  and disagree.
- E2E: highlight a passage, categorise it, close and reopen the project, and confirm it survives
  with its category and appears in the Research panel — the renderer-persistence rule this repo
  enforces because stale plugin state has bitten it before; open a fixture PDF, highlight in it,
  and cite from that highlight, asserting the inserted citation carries the page locator.
- Manual: a project on SFTP with a PDF attached — confirm the attachment uploads, reopens on a
  second machine, and that the file tree and search index both ignore `.thepub/research/`.
