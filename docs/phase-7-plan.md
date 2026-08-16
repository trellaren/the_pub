# Phase 7 — Pagination and page view *(optional, deferred)*

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 7. **This phase is not scheduled.** It is
written down so that if page-accurate on-screen layout is ever judged worth its price, the price
is known in advance and the two decisions that make it survivable are already made.

Read the roadmap's scoping note first: everything a thesis or research paper needs — a source
library, citations, bibliographies, numbered headings, front and back matter, footnotes — is
*content*, and Phases 3–6 deliver all of it without page geometry. Nothing below is a prerequisite
for anything above. This is the phase you take only when a user's actual complaint is "I cannot
see where page 4 ends."

## What it buys, stated first

- A page view: paper-shaped pages on screen, with the breaks in the places they will print.
- Headers and footers, page numbers, columns, widow/orphan control.
- Cross-references that resolve to a page number, which Phase 3 explicitly ruled out.
- Footnotes rendered at the bottom of the page they belong to, rather than in the endnotes region
  Phase 3 built.

## What it costs

A layout engine is a permanent maintenance obligation. Every font metric, every image, every
table, every new node type any later phase adds becomes an input to `paginate()`, and every one
of them can break page fidelity in ways only a human eye catches. Word and browsers each employ
teams on this. Budget accordingly, and treat the estimate as a floor.

## Decision 1 — Sections live in the `.pubdoc` envelope, never in the content

Headers, footers and section-level page setup are **not** ProseMirror content. If they were, they
would sit inside the document's own position space, and then:

- `extractPlainText` would feed header text to search and to the AI context;
- `countWords` would count it;
- `diffBlocks` (`src/shared/pm/diffDocument.ts`) would show a header edit as a body change in the
  History panel;
- the mention scanner would match a character's name in a running header;
- find/replace would walk into it.

Every one of those is a real bug, and each would have to be special-cased in a different file.
Keeping sections in the envelope — a sibling of `content` in `pubDocumentSchema`
(`src/shared/model/document.ts`) — costs one schema field and makes all five problems not exist.
It is also what makes the `.docx` mapping mechanical, since OOXML's `sectPr` is itself
envelope-level, and `src/main/services/docxService.ts` already passes page width/height/margin to
`toDocx` from `manifest.settings` rather than from the document body.

```ts
sections: z.array(z.object({
  startBlockIndex: z.number().int().min(0),
  page: pageSetupSchema,                      // width, height, margins, orientation, columns
  header: pmDocSchema.optional(),
  footer: pmDocSchema.optional(),
  headerFirstPage: pmDocSchema.optional(),
  footerFirstPage: pmDocSchema.optional()
}).array()).optional()
```

Headers and footers are themselves ProseMirror docs — separately edited, separately positioned —
which is exactly the point: they get the editor's full capability without sharing the body's
position space.

`pageWidth`/`pageHeight`/`pageMargin` currently live in `projectSettingsSchema`
(`src/shared/model/manifest.ts`) and are read only at export time. They become the *default* for a
document's first section rather than the only page setup that exists.

## Decision 2 — Pagination by decorations over one contiguous document

**Never page nodes.** If one thing is taken from this plan, take this. Wrapping content in page
nodes would:

- destroy undo granularity, since a repagination is a structural change and every keystroke
  causes one;
- break jump-to-paragraph and find, which address top-level block indexes;
- corrupt the History diff, because `extractRawBlocks` would see pages, not paragraphs;
- invalidate every position calculation in the mention, anchor and field code — all of which work
  in the normalised block-text coordinate space established in `src/shared/pm/extractText.ts` and
  used by `src/shared/pm/anchors.ts`, `mentions.ts` and `toc.ts`.

The document stays one flat sequence of blocks. Pages are **decorations**: a widget between the
blocks where a break falls, plus CSS supplying the paper edges. Nothing in the model changes when
the page size changes, which means nothing downstream of the model has to care that pagination
exists at all.

## Decision 3 — One `paginate()`, shared by screen and print

```ts
// src/shared/pagination/paginate.ts
paginate(doc: PmDoc, styles: NamedStyle[], setup: PageSetup, measure: Measurer): PageBreak[]
```

Pure, given a `Measurer` — an injected interface returning the height of a block at a given width.
Screen supplies a DOM-backed measurer; export/print supplies the same one via an offscreen
measurement pass. The breaks you see and the breaks you print are the same breaks **by
construction**, not by two implementations happening to agree. This is the single most important
structural choice after "not page nodes", and it is the thing that is impossible to retrofit.

Incremental repagination is not optional at this scale: a full re-measure of a 120,000-word
document on every keystroke is not viable. `paginate()` must accept a starting page and a dirty
block index, and re-flow forward only until the break positions reconverge with the previous
result — which they almost always do within a page or two.

## Sequencing, if it is ever taken

1. `pageSetupSchema` + `sections` in the envelope; export reads them instead of
   `manifest.settings`. **Ships alone, useful alone** — this is per-document page setup and real
   headers/footers in exported `.docx`, with no on-screen pagination at all. If the phase stops
   here, it was still worth doing, and nothing above is wasted.
2. `paginate()` + `Measurer`, unit-tested against fixed synthetic metrics with no UI.
3. The decoration layer and page-view CSS, behind a setting (Phase 1's registry) defaulting off.
4. Incremental repagination, driven by a real 120k-word document.
5. Page cross-references — a new `field` kind, resolving through `paginate()`'s output. Cheap once
   1–4 exist, and impossible before.
6. Footnotes move from the endnotes region to page-bottom rendering. Phase 3's model needs no
   change; only the rendering does — which is the payoff of having kept footnote content adjacent
   to its reference in the document.

Steps 1 and 2 are independently valuable and carry no risk to anything already shipped. Step 3 is
where the permanent cost starts. Deciding to stop after step 2 is a legitimate outcome.

## Verification

- `paginate()` unit tests with a synthetic `Measurer` — this is the whole reason for injecting one.
  Cover: a block taller than a page, `keepWithNext` (already on `paragraphStyleAttrsSchema`),
  `pageBreakBefore` (likewise), widow/orphan control, and a footnote that grows its page's
  reserved bottom area enough to push its own reference to the next page — the classic
  circularity, and the case a naive implementation loops on forever.
- An incremental-repagination test asserting that a keystroke on page 2 of a 400-page document
  re-measures a bounded number of blocks, not all of them.
- E2E: page view on, type at the top of a long document, confirm later breaks stay put; export and
  confirm the printed breaks match the on-screen ones.
- Manual, and non-negotiable: the same document in The Pub's page view and in Word, side by side,
  at several page sizes. Page fidelity is judged by eye or not at all.
