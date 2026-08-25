# The Pub — roadmap

The original brief is complete: Phases 1–8 built the editing shell, story records, the two
planning views, maps, AI assistance, remote projects, Word round-trip and OneDrive. This document
covers what comes next — growing The Pub from a story-planning tool into something that also
serves an essay, a thesis or a research paper, without losing what makes it good at a novel.

It is a direction of travel, not a schedule. Phases are ordered by dependency, and each one is
meant to be shippable on its own.

**Status:** Phases 0–6 and 8–15 have shipped, each with a build plan linked from its section
below. Phase 7 (pagination) is deliberately deferred: steps 1 and 2 of its sequence — per-document
page setup, real headers and footers in exported `.docx`, and a pure `paginate()` — are built,
because they are useful on their own; step 3, where the permanent cost starts, is not.

## Two scoping decisions

**Desktop only.** There is no mobile build on this roadmap. The shared-core extraction that a
mobile app would have required is dropped with it — that work was only ever worth doing in
service of a second platform.

**Research papers without becoming a document processor.** Supporting a thesis or a research
paper sounds like it demands pagination — page view, headers and footers, footnotes at the
bottom of a page. Most of it does not. A source library, citation fields, bibliographies,
numbered headings and front/back matter are all *content*, and none of them need page geometry.

The one genuine coupling is footnotes, and it is escapable: keep footnote content in the
document, edit it in a popover, render it on screen as an endnotes region, and let **export**
own page placement. The `docx` library already emits real Word footnotes; Word and PDF do the
page maths. That yields correct Chicago output without owning a pagination engine.

What that costs, stated plainly: no page view, no live "what is on page 4", and a cross-reference
can resolve to a heading but not to a page number. Pagination stays on the roadmap as an
optional later phase (Phase 7), reached only if page-accurate on-screen layout proves to be worth
its considerable price.

---

## Phase 0 — Format governance and stable identity

*Prerequisite for everything below. Detailed build plan: [`phase-0-plan.md`](./phase-0-plan.md).*

**The bug this fixes is live today.** `formatVersion` is stamped into every file The Pub writes
(`src/shared/model/document.ts`, and nine sibling models) but is never read anywhere.
`DocumentService.write` re-stamps `FORMAT_VERSION` unconditionally. `pmNodeSchema` is permissive
by design, so an older build opens a newer `.pubdoc` without complaint — but `createEditor` runs
with `enableContentCheck: true`, drops node types it does not know, and autosave writes the lossy
content back under the older stamp. Every phase below adds node types. This has to be fixed
before any of them.

- A migration framework (`src/shared/model/migrate.ts`) with per-file-kind version tracking and a
  **too-new guard**: a file written by a newer build is opened read-only, never overwritten.
- **Stable identity in ProseMirror**, in two deliberately distinct mechanisms:
  - a lazily-allocated `blockId` global attribute, for cross-references, TOC targets and
    bookmarks — assigned only to blocks something actually points at, because assigning one to
    every paragraph would bloat every `.pubdoc`;
  - an `anchor` **mark** carrying an `anchorId`, for annotations that span a range of text.

  Both follow the reasoning already recorded in `mention.ts` and `entity.ts`: marks over nodes,
  ids over copies, and identity keyed by surface rather than by offset so it survives editing
  around it.

## Phase 1 — Settings, menus and keybindings

Pulled forward, because every phase after it wants to add settings and none of them should have
to add an IPC channel to do it.

- A flat, VS Code-style registry in `src/shared/model/settings.ts` — `SETTING_DEFS`,
  `buildScopeSchema`, `resolveSetting` — replacing the hand-written `projectSettingsSchema`.
  Every existing key name is kept, so v1 projects need no migration.
- The menu tree lifts out of `src/main/menu.ts` into data (`menuModel.ts`, `keybindings.ts`);
  `buildMenu` becomes a pure mapper from that data plus the user's customisations. Menu items,
  shortcuts and the command palette already run one code path — this makes all three editable.
- Two generic channels, `settings:read` and `settings:update`, retire the per-preference
  `app:setTheme` / `app:setTimelineOrientation` pattern.
- A Settings panel and a keybindings editor as **dock panels, not modals** — that is the IDE
  metaphor, and it gets popout and layout persistence for free.
- Settings are written as sparse patches, so changing a default in a later release actually
  reaches existing users.

## Phase 2 — Notes

Notes attached to a document, and to a range of text within it. The first real consumer of Phase
0's `anchor` mark.

- Note **bodies live in a sidecar**, `.thepub/notes/<docId>.json` — not in the `.pubdoc`. This is
  the same reasoning already written into `entity.ts` for why entity notes left the manifest,
  inverted: a note must not be counted by `countWords`, must not appear in `extractPlainText`
  (which feeds search and AI context), must not pollute the History panel's diff, and must not
  have to survive a Word round-trip as an alien node. Only the `anchorId` mark is in the
  document.
- One file per document, so remote VFS writes stay small and two documents cannot conflict.
- `noteService.ts` follows `EntityService`'s load/save/debounce/snapshot shape.
- **Orphan handling is the whole game.** When an anchor can no longer be found the note becomes
  *detached*, never deleted, and recovery re-finds it by its stored surface text using the
  normalisation machinery in `extractText.ts` — exactly as the mention scanner does. Restoring a
  snapshot re-runs recovery, since restoring an old version resurrects old anchor ids.

## Phase 3 — Fields, footnotes and endnotes

The content half of what a word processor gives you, without the page geometry.

- **One inline atom node, `field`**, serving cross-references, tables of contents and (later)
  citations alike, with a `cachedText` attribute. That attribute is load-bearing: it keeps
  `extractPlainText`, `countWords`, the search index and DOCX export correct without any of them
  needing to understand fields at all.
- **Footnotes as an inline node containing block content**, `isolating` and `defining`. Content
  sits adjacent to its reference, so deleting the marker deletes the note and cut/paste carries
  it — the two behaviours people actually expect. Numbering is **never stored**; it is computed
  from document order. On screen: a superscript marker, popover editing, and an endnotes region.
  On export: real Word footnotes.
- `fromDocx.ts` gains footnote import. This is where the warning string about imports leaving
  footnotes behind finally gets retired.
- **TOC and cross-references** as field types, built by a pure `buildToc` walking headings via
  `resolveStyle().headingLevel` plus a new `outlineLevel` on `namedStyleSchema` — so a style can
  be *in* the contents independently of whether it renders as a heading. A reference resolves to
  heading text and number; page references are explicitly out of scope until Phase 7.

## Phase 4 — Project templates

*Detailed build plan: [`phase-4-plan.md`](./phase-4-plan.md).*

Projects are plain folders, so **a template is just a project, serialised.** No second concept.

- Built-in templates as JSON under `resources/templates/`; user templates in `userData`; a
  "Save Project as Template…" command that snapshots the current styles, settings and an opt-in
  subset of files.
- `templateService.instantiate` writes through the `VfsAdapter`, which means a template
  instantiates onto SFTP, FTP or OneDrive with no additional code. That is the payoff of the VFS
  abstraction.
- `projectType` on the manifest drives which panels are offered and which layout preset a new
  project opens with.
- Templates are **one-shot seeds, never live-linked**, so updating a built-in can never reach
  into somebody's existing project.

## Phase 5 — Citations and bibliography

*Detailed build plan: [`phase-5-plan.md`](./phase-5-plan.md).*

Chicago, MLA and APA — built on CSL rather than hand-rolled. Chicago alone has two systems and
hundreds of edge cases, and CSL styles are maintained by people who care about them more than we
ever will.

- A CSL-JSON source library in `.thepub/sources.json`. `sourceService.ts` is the third clone of
  the `EntityService` pattern, so extract a shared `jsonCollectionService.ts` base here and
  retrofit entities, beats and maps onto it.
- citeproc runs in the **renderer**, writing results into `cachedText`. That keeps a heavy
  dependency out of the main process, makes export deterministic, and means a document exported
  on a machine without the style file still renders correctly.
- Ships Chicago (both systems), MLA and APA under `resources/csl/`. User-importable `.csl` gives
  IEEE, Harvard, Vancouver and a hundred journal styles for free.
- The citation picker reuses the `Suggestion` plumbing already in `mention.ts`, with a different
  trigger character.
- BibTeX and RIS import, plus DOI/ISBN lookup, follow.

Depends on Phase 3: Chicago notes-bibliography renders into footnotes.

## Phase 6 — Beyond fiction

*Detailed build plan: [`phase-6-plan.md`](./phase-6-plan.md).*

Once Phase 4 exists, most of this is configuration.

- **Thesis, essay and research-paper templates**, each with a style preset and a citation style.
- **Numbered headings** — `numbering: { format, startAt, levelText }` on `namedStyleSchema`. A
  real gap today, and the thing an academic notices first.
- **Front and back matter** through the existing `partRoleSchema` and its ordering validation.
- **Panel vocabulary** — generalise `entityKindSchema` from Characters and Locations to a
  project-configurable list (interviewees, concepts, sources), driven by `projectType`.
- **Screenplay** is the one case that needs real code, and less of it than expected: screenplay
  elements map remarkably well onto named styles, because the Enter handling in `namedStyles.ts`
  is *already* Word's "style for the following paragraph", which is exactly how screenplay
  editors work. Adds a style pack, Tab-cycles-element, scene-heading autocomplete fed by the
  location records, and `.fountain` import/export mirroring `src/main/docx/`.

## Phase 7 — Pagination and page view *(optional, deferred)*

*Detailed build plan: [`phase-7-plan.md`](./phase-7-plan.md).*

Only if page-accurate on-screen layout is later judged worth its cost. If it is taken:

- **Sections live in the `.pubdoc` envelope, not in the ProseMirror content.** Headers and
  footers held inside the document's own position space would be seen as body text by
  find/replace, word count, the diff, the mention scanner and export. Keeping them out is also
  what makes the mapping to `.docx` mechanical.
- **Pagination by decorations over one contiguous document — never page nodes.** Page nodes
  would destroy undo granularity, break jump-to-paragraph and find, corrupt the History diff, and
  invalidate every position calculation in the mention code. If one thing is taken from this
  document, take this.
- A pure `paginate()` shared by screen and print, so the page breaks you see and the page breaks
  you print are the same page breaks by construction, not by coincidence.
- This is what would unlock headers and footers, page numbers, columns, widow/orphan control and
  page cross-references.

## Phase 8 — An embedded model, a choice of them, or none

*Detailed build plan: [`phase-8-plan.md`](./phase-8-plan.md).*

Three postures, the writer's pick: **AI off** — no panel, no menu items, no processes, The Pub
as a plain writing tool; **an embedded model** chosen from a small curated catalogue, running
inside the app as the project's routine agent, with nothing leaving the machine; or **hosted
providers** exactly as today.

- **An app-scoped `aiEnabled` switch** above the provider picker. The person's setting, never
  the project's — a shared folder must not switch AI on for a collaborator who opted out. Off
  removes every AI surface from the menu model rather than greying it out, and costs zero bytes
  because nothing AI-shaped ships in the installer.
- **A fifth provider id, `embedded`**, in the existing list in `src/shared/model/ai.ts` — that
  file's own comment, everything above the provider layer is identical, is the design being
  cashed in.
- **One managed llama.cpp `llama-server` child process**, model-agnostic — GGUF in, tokens out —
  so the catalogue is data, not engine code. Never in-process bindings: inference that dies must
  take a subprocess with it, not unsaved manuscript.
- **A curated catalogue**: `prism-ml/bonsai-27b` as the flagship recommendation, plus a mid-size
  and a small model so modest hardware gets a private routine agent instead of a refusal — the
  per-variant RAM gate refuses the 27B *and offers the 4B*. Which model answers rides the
  existing `aiSettings.model` field, per-chat overrides included; sideloading a local `.gguf` is
  an escape hatch, not the product.
- **Weights download on first use into userData** — never bundled, never in a project folder
  (the `AiKeyStore` reasoning). Resumable, checksummed, license accepted per model before its
  first byte; several models may coexist, one loaded at a time.
- Lazy start, idle shutdown, killed on quit — gigabytes of RAM are borrowed, not owned.
- `FORMAT_VERSIONS.chats` bumps so an older build opens a chats file mentioning the new provider
  read-only instead of corrupt-renaming it.

## Phase 9 — Co-authoring and peer review

*Detailed build plan: [`phase-9-plan.md`](./phase-9-plan.md).*

Several people on one project folder, merging cleanly — **asynchronous over the existing VFS, not
real-time.** No CRDT, no relay server: the cost, plainly, is that two people must not type in the
same document at the same moment. Presence makes that visible; everything around the prose is
built to merge with no conflict at all.

- **Author identity** as an app-scoped profile (id, name, colour); everything stamped by id,
  never by name — the same ids-over-copies rule records already follow. A per-project
  `authors.json` renders collaborators offline.
- **Review comments and threads**, anchored by Phase 0's `anchor` mark with the same orphan
  recovery notes use, stored **one file per (document, author)** —
  `.thepub/reviews/<docId>/<authorId>.json` — so every file is single-writer by construction and
  replies to someone else's thread live in *your* file, assembled by id at load.
- **Suggested edits** as two marks, `insertion` and `deletion`, written by a suggesting-mode
  transaction filter; accept/reject are pure inverses. Word count and extraction count the
  document as-if-accepted, implemented once in `extractText.ts`'s single text walker.
- **The Word round-trip is the payoff**: suggestions export as real `w:ins`/`w:del`, threads as
  real Word comments, and Word tracked changes import back as first-class suggestions — a
  reviewer without The Pub reviews in Word.
- **Presence is advisory, never a lock**; `DocumentService`'s mtime check stays the backstop,
  and the `ConflictBar` gains a mine-vs-disk diff.

## Phase 10 — Database-backed projects, and an agent that can act

*Detailed build plan: [`phase-10-plan.md`](./phase-10-plan.md).*

Two tracks that share no code, numbered together because they ship together. Either can land
first.

- **A `db` protocol** joining `sftp`, `ftp` and `onedrive` — one protocol with a dialect per
  engine (Postgres, MySQL, SQLite), because the `VfsAdapter` mapping is identical and only the
  SQL differs. It is the first backend that is *better* than local disk at what this app finds
  hard: real atomic writes as transactions, and change detection as `WHERE rev > ?` instead of
  `pollingWatch`'s full recursive walk — with `LISTEN`/`NOTIFY` making Postgres a genuine push
  backend.
- `FORMAT_VERSIONS.connections` bumps, because an older build meeting a `db` profile fails the
  protocol enum and corrupt-renames the file — losing **every** saved server, not just the new
  one.
- **An agent that acts**, the half Phase 8 scoped out, resting on one rule: *the agent never
  writes to a document — it proposes, and proposals arrive as Phase 9 suggestion marks.*
  Accept/reject, attribution, Word round-trip and undo then all come for free instead of being
  rebuilt worse.
- A small read-mostly tool surface over services that already exist, plus **semantic retrieval**
  as an `embeddings` table in the search index — vectors from the *embedded* model, brute-force
  cosine, no ANN index, and nothing at all when AI is off.

## Phase 11 — Highlighting and the research library

*Detailed build plan: [`phase-11-plan.md`](./phase-11-plan.md).*

A writer marks a passage because it matters — in their draft, or in what they are reading — and
later wants every marked passage together, with the citation attached.

- **The existing `highlight` mark gains a lazily-allocated `highlightId`.** Absent, it is yellow
  text exactly as today; present, it is a record with a category, a note and orphan recovery.
  Phase 0's `blockId` reasoning applied to a mark — identity only for what something points at.
- **Sources get attachments**: PDFs and web captures under `.thepub/research/`, written through
  the `VfsAdapter`, so a research library works on SFTP and OneDrive with no backend-specific
  code — and never in the manuscript tree, where the indexer and file tree would find them.
- **PDF highlights anchor by quoted text first, page coordinates second** — the same recovery
  ordering the document highlights use, because coordinates break and quotes survive.
- **Cite from a highlight**, locator prefilled from the page: Phase 5's `insertCitation` called
  with an argument, not new machinery.
- A Research panel over both halves, with the orphaned section notes taught us to build.

## Phase 12 — Publishing and output

*Detailed build plan: [`phase-12-plan.md`](./phase-12-plan.md).*

The app takes a book from a blank folder to a finished, cited, reviewed draft — and then the only
ways out are `.docx` and `.fountain`, both handoff formats for other software.

- **Every output consumes the binder**, via `flattenManuscript`'s existing `ExportItem[]` stream.
  An output with its own traversal would drift from the DOCX one the first time a part moved.
- **EPUB 3** as a sibling of `src/main/docx/`, with the same no-knowledge-of-a-project rule;
  `nav.xhtml` built by the *same* `buildToc` the in-document contents uses, because two
  table-of-contents implementations disagree and one of them does it silently.
- **PDF prints the paginated view rather than laying it out again** — Phase 7's `paginate()` in
  an offscreen window through `printToPDF`, so screen, print and PDF are the same breaks by
  construction. A PDF library would be a second layout engine.
- **Submission formats are configuration, not code** — a style pack plus page setup plus header
  text, shipped as Phase 4 templates. Phase 6's lesson, applied to output.
- One `publish:export` channel replacing the per-format pairs, reporting what each format cannot
  carry.

## Phase 13 — Goals and statistics

*Detailed build plan: [`phase-13-plan.md`](./phase-13-plan.md).*

- **Snapshots cannot be the history**, and the plan says exactly why: a ten-minute minimum
  interval, a 50-per-document cap that prunes the oldest, per-document series, and an off switch.
  A history that deletes its own beginning is not one.
- **Daily rollups per author** (`.thepub/stats/<authorId>.json`), single-writer by construction —
  Phase 9's rule, adopted for the same reason.
- **Gross added *and* removed, not just net.** A revision day that cuts 2,000 words and writes
  1,800 reads as −200, and a tool showing only net tells a writer who worked hard that they did
  nothing.
- Sessions measured by an idle timeout so an app left open overnight does not award eight hours;
  targets derived from what remains and the days left, so the number stays honest after a week
  off; charts as hand-drawn SVG, because `MapCanvas` already proves that is enough.

## Phase 14 — Accessibility and language

*Detailed build plan: [`phase-14-plan.md`](./phase-14-plan.md).*

The only phase here that decides whether some writers can use the app at all, rather than how
well it serves them.

- **Half fixes, half things that keep the fixes true**: axe-core in the e2e suite and
  keyboard-only paths asserted in tests, because an accessibility sweep regresses on the next
  feature.
- Roles, names and live regions across the dock, the file tree and the popovers; text labels for
  everything currently carried by colour alone (mentions, suggestions, highlights, map markers).
- **Contrast checked by a unit test across all twelve themes**, the same way the DOCX closed-world
  test makes a rule the suite enforces rather than one someone remembers.
- **Per-document `lang` in the envelope and a `lang` mark for passages**, fixing a real defect
  today: DOCX export states no language, so Word spell-checks a French chapter against English.
- **RTL turns alignment into start/end rather than left/right** — the part that is not free, and
  the part that puts every paragraph on the wrong side of an exported Hebrew manuscript if missed.

---

## Dependencies

```
Phase 0  Format governance + stable ids     ← blocks everything
   ├→ Phase 1  Settings / menus / keybindings   ← blocks 3, 4, 5, 6
   ├→ Phase 2  Notes                            (first consumer of anchors)
   └→ Phase 3  Fields, footnotes, endnotes
          └→ Phase 5  Citations
   Phase 4  Templates   (needs 1)
          └→ Phase 6  Beyond fiction
   Phase 7  Pagination  (optional; independent, expensive)
          └→ Phase 12  Publishing and output   (also needs 3, 5, 6)
   Phase 8  Embedded model   (independent; builds on the shipped AI layer)
          └→ Phase 10b Agentic assistance   (also needs 9, for suggestions)
Phase 0 → Phase 9  Co-authoring + peer review   (anchors; sits beside 2's notes)
   Phase 10a Database connections   (independent)
Phase 0 → Phase 11  Highlighting + research library   (also needs 5)
   Phase 13  Goals and statistics       (independent)
   Phase 14  Accessibility and language (independent)
```

Phase 10 is two tracks under one number: **10a** (database connections) depends on nothing, while
**10b** (the agent) needs both 8 and 9. They share no code and either can ship first.

## Phase 15 — An assistant that can build things

*Detailed build plan: [`phase-15-plan.md`](./phase-15-plan.md).*

Phase 10b's agent can read a project and propose prose edits. This is the half a writer asks for
next: draft a character, fill out a cast, bring research back with its citation attached.

- **One boolean, `provisional`, on records and sources.** A draft the assistant wrote is a *real*
  record — searchable, mentionable, linkable to a beat — that is visibly not yet accepted.
  Accepting clears the flag; that is all accepting does. A draft in a sidecar file is a preview,
  not a draft, because you cannot work with it.
- **A tool may only modify what it created and nobody has accepted.** Enforced by the service
  refusing, the way `ReviewService` refuses another author's thread — not by asking the model
  nicely.
- **An ensemble is generated as a group, in one request, against stated constraints** ("exactly
  one is lying about why they signed on"), and the constraints are validated by us afterwards.
  N independent rolls is why every ensemble generator produces the same person eight times.
- **Research records a claim and its attributed citation; it does not browse.** A confident
  fabricated citation in a thesis bibliography is career damage, so the card says "attributed by
  the assistant — not verified" and fetching waits for Phase 11's research library.

## The decisions that matter most

1. **Fix `formatVersion` before anything else.** It is a correctness bug today, not merely a
   prerequisite.
2. **Note bodies in a sidecar; footnote bodies in the document.** The dividing line is "does it
   print and count" — the same line `entity.ts` already draws for a different reason.
3. **One `field` node with a `cachedText` attribute** serves contents, cross-references and
   citations, and spares every consumer from understanding fields.
4. **Page placement is an export concern** until proven otherwise. Owning a pagination engine is
   a large, permanent cost, and the research-paper story does not require one.
5. **A template is a project, serialised.** Projects are folders; do not invent a second concept
   alongside them.
6. **The agent proposes; it never writes.** Routing every agent edit through Phase 9's suggestion
   marks inherits accept/reject, attribution, undo and the Word round-trip instead of rebuilding
   four mechanisms worse — and it is what makes an agent over someone's manuscript acceptable at
   all.
7. **The assistant's records are provisional, not hidden.** The same proposal-then-commit shape
   as suggestion marks, applied to records and sources — one idea implemented twice, rather than
   two mechanisms that drift.
8. **Every output consumes the binder.** EPUB, PDF and print go through the same
   `flattenManuscript` stream as DOCX, and PDF prints the paginated view rather than laying it
   out a second time. Two layout engines disagree; two traversals drift.
