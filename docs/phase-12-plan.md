# Phase 12 — Publishing and output

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 12. Depends on Phase 7 (shipped) for
`paginate()`, Phase 3 for footnotes, Phase 5 for bibliographies and Phase 6 for numbered headings
and front/back matter.

## Why now

The app takes a book from a blank folder to a finished, cited, reviewed draft — and then the only
ways out are `.docx` and `.fountain`. Both are handoff formats for *other* software. Nothing The
Pub produces can be read by a reader or sent to an agent as-is.

Phase 7 is what makes this the right moment. `src/shared/pagination/paginate.ts` is a pure
function shared by screen and print, written so that "the page breaks you see and the page breaks
you print are the same page breaks by construction". Until it existed, page-accurate PDF meant
owning a second layout engine. It exists, so PDF is now a consumer rather than a project.

## The decision that shapes the phase

**Every output is a consumer of the binder, not a new pipeline.** `flattenManuscript`
(`src/shared/model/manuscript.ts`) already turns parts, roles and documents into one
`ExportItem[]` stream, and `docxService` already consumes it. EPUB and PDF consume the same
stream. Any output that needed its own traversal of the project would drift from the DOCX one
the first time somebody reordered a part — and the front/back-matter ordering rules encoded there
are exactly the rules a title page and an appendix need in every format.

## Part 1 — Publication metadata

Everything a book needs and a manuscript does not: subtitle, author display name (distinct from
Phase 9's `authorId`), publisher, ISBN, language, rights, publication date, series, cover image
path, and a description. It goes on the manifest, in its own block:

```ts
publication: publicationSchema.prefault({})
```

`FORMAT_VERSIONS.manifest` bumps with a no-op `MIGRATIONS.manifest` step — the fifth such entry,
for the reason the four before it record.

Kept out of `projectSettings`, which is editor behaviour (autosave, page size, default style).
Publication metadata is *content about the work*, it is what an OPF and a title page are built
from, and mixing the two would put an ISBN next to an autosave debounce.

## Part 2 — EPUB 3 (`src/main/epub/`)

A sibling of `src/main/docx/`, with the same shape and the same rule: **no knowledge of a
project.** It takes documents, styles and metadata, and returns bytes.

```
src/main/epub/
├─ toEpub.ts        the orchestrator, mirroring toDocx.ts
├─ xhtml.ts         ProseMirror JSON → XHTML, the counterpart of toDocx's run builder
├─ css.ts           NamedStyle[] → a stylesheet, mirroring styleMap.ts
├─ opf.ts           package document, spine, manifest, metadata
└─ nav.ts           nav.xhtml (and an NCX for older readers)
```

- **One XHTML file per document**, because that is the unit a reader's progress, bookmarks and
  chapter navigation are measured in.
- **Styles become CSS classes**, not inline attributes — `styleMap.ts` already proves the
  NamedStyle → format mapping, and a reflowable book that hardcodes a font size is a book nobody
  can read comfortably. The named style is the class; direct formatting stays inline.
- **`nav.xhtml` is built by `buildToc`** (`src/shared/pm/toc.ts`), the same pure function that
  builds the in-document contents. Two table-of-contents implementations would disagree, and the
  one that disagrees silently is the one in the file the reader navigates by.
- **Footnotes become `epub:type="footnote"`** with a backlink, inside `<aside>`, which is what
  gives a modern reader its popup and every other reader a working endnote. Phase 3's node
  already keeps content adjacent to its marker, so numbering is computed from document order here
  exactly as it is on screen.
- **`field` nodes export as their text child.** No special case, in the same way DOCX needs none
  — the property `field` was built for.
- **Images** are copied from `ASSETS_DIR` into the container and rewritten to relative hrefs;
  the cover gets `properties="cover-image"` and a landmark.

EPUB is a zip. `docx` (the library) brings its own zip writer for the DOCX path, so the
dependency question here is one small zip library — chosen for deterministic output, because two
exports of an unchanged book should be byte-identical.

## Part 3 — PDF and print

### The decision: print the paginated view, do not lay it out again

Electron's `webContents.printToPDF` renders the same DOM the editor already paginates. A PDF
library (pdfkit, jsPDF) would mean measuring text, breaking lines and placing footnotes a second
time — a second layout engine, disagreeing with the first on exactly the documents that matter.

So: `src/main/print/printService.ts` opens an **offscreen `BrowserWindow`** on a dedicated
renderer route that mounts the paginated view over the flattened binder with editing chrome off,
waits for fonts and images, and calls `printToPDF` with the page setup from `pageSetupSchema`.
The route is served by the same loopback `rendererServer` a packaged build already runs
(`src/main/server/rendererServer.ts`) — this is the second consumer of that server, and a good
reason it exists.

Consequences, stated because they are real: headless CI needs a display for this path (the e2e
suite already runs under `xvfb-run`), and the offscreen window must be destroyed on failure, so
the service owns it in a `try`/`finally` the way `AiRunner` owns its `AbortController`.

**Print** is the same route through `webContents.print`, so what prints and what exports as PDF
are the same pixels.

## Part 4 — Submission formats

An agent or a journal wants standard manuscript format: 12pt monospace or Times, double-spaced,
first-line indents, a name-and-address block, `#` scene separators, running headers of
`Surname / TITLE / page`. **None of that is code.** It is a style pack plus a page setup plus
header/footer text — all three of which are data this app already models, after Phases 6 and 7.

So submission formats ship as **project templates** (Phase 4): `resources/templates/submission-*`
carrying the styles and page setup, plus an "Apply preset" command that writes a preset's styles
and page setup over the current project without touching its prose. That is Phase 6's lesson —
"once Phase 4 exists, most of this is configuration" — applied to output rather than input.

Word-count on a title page uses `countWords` over the flattened binder, rounded the way
submission convention expects.

## Part 5 — One export dialog

`docx:exportDialog` and `fountain:exportDialog` are two channels with near-identical bodies, and
EPUB, PDF and print would make five. This phase collapses them into `publish:export` /
`publish:exportDialog` taking a `format` discriminator, with the existing channels kept as thin
aliases for one release so nothing in the renderer breaks in the same commit.

The dialog shows what the format cannot carry — the honest counterpart to
`docxImportResultSchema.warnings`: EPUB has no page numbers, so a page cross-reference degrades
to a link; a fixed-layout PDF cannot reflow. Saying so at export time is cheaper than a reader
discovering it.

## Deliberately out of scope

Uploading to KDP, IngramSpark, Smashwords or a journal's submission portal; DRM; fixed-layout
EPUB (a picture book is a different product); print-shop imposition, bleed and crop marks;
MOBI/AZW3 (Amazon converts EPUB itself, and the format is retired); and LaTeX output — a thesis
that needs LaTeX needs a LaTeX workflow, not a converter.

## Verification

- `bash ci/run-checks.sh`.
- Unit: `toEpub` against hand-written fixtures asserting OPF spine order matches
  `flattenManuscript` including front and back matter; `nav.xhtml` matching `buildToc`'s output
  for the same document set; footnote and backlink pairing; a closed-world test mirroring
  `toDocx.test.ts`'s — **every node and mark type the editor can produce must be handled by the
  XHTML writer**, so a node added in a later phase fails loudly here too rather than vanishing
  from ebooks; deterministic zip bytes across two runs.
- Unit: the submission preset applying styles and page setup without altering document content
  (a diff of every `.pubdoc` before and after must be empty).
- E2E: export a two-part manuscript with front matter, footnotes and a bibliography to EPUB,
  unzip it in the test and assert structure; export the same to PDF under `xvfb-run` and assert a
  non-trivial page count and that the offscreen window is gone afterwards.
- Manual: the EPUB through `epubcheck` with no errors, opened in Apple Books, Calibre and a
  Kobo; the PDF's page breaks compared against the on-screen paginated view — they must match,
  which is the entire claim Phase 7 was built to make true.
