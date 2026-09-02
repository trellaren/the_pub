# Phase 9 — Co-authoring and peer review

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 9. Depends on Phase 0 (shipped): the
`anchor` mark and its text-based recovery are what comments attach by. Sits beside Phase 2's
notes without touching them. The Word half leans on `src/main/docx/`.

## The scoping decision: asynchronous, not real-time

Co-authoring here means **several people working on the same project folder, at different
moments, with their work merging cleanly** — not live cursors. Real-time co-editing needs a CRDT
or OT document model and a relay server; the roadmap has no server, the app is desktop-only, and
rebasing `.pubdoc` onto a CRDT would invalidate snapshots, the History diff, and every offset
calculation the mention code depends on.

What the app already has is the right substrate for the asynchronous version: projects live on
shared backends (SFTP, FTP, OneDrive) through the `VfsAdapter`, `pollingWatcher` surfaces other
people's writes within its 15-second interval, and `DocumentService.write`'s mtime check plus the
`ConflictBar` already refuse to silently clobber.

The cost, stated plainly: two people must not type in the same document at the same moment. The
unit of concurrent work is the document — presence (Part 6) makes that visible, and the conflict
bar remains the backstop when it is ignored. Everything *around* the prose — comments, replies,
suggested edits by different reviewers — is designed below to merge with no conflict at all.

## Part 1 — Who is writing

### Author profile, app-scoped

A profile in **userData** (alongside the existing app state, not in any project): a ulid
generated once, a display name, a colour. No accounts, no server, no verification — the trust
model is a writing group or a supervisor, the same people you would email the manuscript to.
Everything this phase writes is stamped with the author id, never the name: **ids over copies**,
the same rule records already follow, so renaming yourself renames you everywhere at once.

### `.thepub/authors.json` (new)

The id → `{ name, color }` registry for a project, appended to on project open. It exists so a
comment renders "Marta", in her colour, when Marta is offline. New `FileKind` `authors` in
`FORMAT_VERSIONS`/`MIGRATIONS`; last-writer-wins per entry is fine — the value is display
metadata, not truth.

## Part 2 — Review comments and threads

A new record kind, distinct from Phase 2's notes on purpose: a note is the author's own margin
thinking; a review comment is addressed to someone and accumulates replies. Both attach the same
way — an `anchor` mark — and orphan recovery (`anchorText`, `blockIndex`, re-finding by
normalised surface text) is reused verbatim from `shared/pm/anchors.ts` and `noteService`'s
reconcile.

```ts
export const reviewThreadSchema = z.object({
  id: z.string(),
  docId: z.string(),
  anchorId: z.string(),
  authorId: z.string(),
  body: pmDocSchema,
  status: z.enum(['open', 'resolved']).default('open'),
  orphaned: z.boolean().default(false),
  anchorText: z.string(),
  blockIndex: z.number().int(),
  created: z.string(),
  modified: z.string()
})
```

### File layout: one file per (document, author)

`.thepub/reviews/<docId>/<authorId>.json`. Phase 2's one-file-per-document layout is right for
notes — one writer — and wrong here: two reviewers commenting on the same chapter would race on
one file, and lose whichever save landed first. One file per (document, author) makes every file
**single-writer by construction**; the read side merges the directory. Concurrent review needs no
merge code on the write path at all.

Replies follow the same rule: a reply *you* write to *Marta's* thread lives in **your** file,
carrying `threadId`, and the thread is assembled at load by id. A reply is its own record, not a
mutation of someone else's.

New `FileKind` `reviews`; `reviewService.ts` follows `noteService`'s load/reconcile/debounce
shape, plus a watcher subscription so a collaborator's newly-synced comments appear without
reopening the project.

## Part 3 — Suggested edits

The reviewer's other verb. Two new marks — **marks over nodes**, the rule `mention.ts` and
`anchors.ts` already record — carrying `{ authorId, at }`:

- `insertion` — text added in suggesting mode, rendered underlined in the author's colour;
- `deletion` — text *kept in the document* but marked, rendered struck through. A suggestion to
  delete must survive until it is judged, so it cannot actually remove anything.

### Suggesting mode (`renderer/panels/editor/extensions/suggestions.ts`, new)

A toggle on the editor. While on, a ProseMirror plugin rewrites transactions: typed text gets the
`insertion` mark; a delete becomes a `deletion` mark over the range instead of a removal;
deleting text that is your own pending `insertion` really deletes it (suggesting to remove your
own suggestion collapses to nothing — the case every tracked-changes implementation gets wrong
first). This plugin is the hardest code in the phase; it is pure transaction mapping, so it gets
plain-data unit tests like `namedStyles`, not editor-instantiating ones.

### Accept and reject

Pure functions in `shared/pm/suggestions.ts`: accept an insertion = strip the mark; accept a
deletion = delete the range; reject is the inverse pair. Driven per-suggestion, per-author, or
per-document from the Review panel, through the ordinary editor command path so undo works.

### The consequences, paid in the right places

- **Text extraction counts the document as-if-accepted**: insertion-marked text counts,
  deletion-marked text does not — a manuscript's word count should be the manuscript's, not the
  argument about it. This lands **once**, in `extractText.ts`'s single walking implementation
  (`nodeText`/`forEachTextNode` grow mark-awareness); search snippets, mention offsets and word
  count all shift together by construction. The one-text-walker house rule is exactly why this is
  a small change and not a bug farm.
- **Schema closed world**: the TipTap extensions; `EDITOR_MARK_TYPES` in `toDocx.ts`;
  `fromDocx.ts`; and `FORMAT_VERSIONS.document` 4 → 5 with a no-op `MIGRATIONS.document` step —
  an older build must open a suggested-on document read-only, not strip the suggestions and
  autosave the loss. The closed-world test in `toDocx.test.ts` polices the list.

## Part 4 — The Word round-trip

The payoff feature: **a reviewer who does not have Quoth reviews in Word, and their work comes
back as first-class suggestions and comments.**

- Export: `insertion`/`deletion` become real `w:ins`/`w:del` with author and date;
  review threads become real Word comments (`w:commentRangeStart`/`End` spanning the anchor
  mark's range, replies as Word comment replies).
- Import: `fromDocx.ts` parses tracked changes into the marks and Word comments into review
  threads with fresh anchors, attributed by the Word author name (matched into `authors.json`, or
  added to it).
- Fixtures in `fixtures.ts` are hand-built from files Word actually wrote — the asymmetry rule:
  never proven only against our own exporter.

## Part 5 — The Review panel

A dock panel, not a modal — the IDE metaphor, with popout and layout persistence for free. It
lists every thread and pending suggestion across the manuscript, grouped by document and
filterable by author and status; click jumps to the range (the same resolved-position jump the
search and notes panels use); accept/reject and resolve act in place. A count badge on open items
is the "is this reviewed yet" answer at a glance.

In the editor itself the marks render natively (per-author colour via CSS variables fed from
`authors.json`), with a small hover affordance for accept/reject-in-place.

## Part 6 — Presence

`.thepub/presence/<authorId>.json`, written as a heartbeat `{ docId, at }` while a document is
open and deleted on close and quit. Read via the existing watcher; entries older than a TTL
(covering the 15-second polling worst case, ~90s) are stale and ignored. The `EditorPanel` shows
a quiet bar: "Marta has this document open." **Advisory only, never a lock** — a lock file left
by a crashed laptop on an FTP server is a support call, and `DocumentService`'s mtime check is
the real guard.

One genuine improvement to that backstop ships here: when the `ConflictBar` fires, it offers a
diff of mine-vs-disk (reusing the History panel's `DiffView`) so keep-mine/reload is an informed
choice. Automatic block-level merge via `blockId` is explicitly deferred — tempting, and a
correctness minefield this phase does not need.

## Deliberately out of scope

Real-time co-editing, accounts and permissions, approval gates ("request changes"), and any
notification service. A comment arriving is the file syncing; that is the product.

## Verification

- `bash ci/run-checks.sh`.
- Unit: the suggesting-mode transaction map (typing, backspace over own insertion, delete over
  someone else's text, paste); accept/reject as exact inverses; `extractText` with the marks
  (word count excludes deletions, mention offsets stay aligned); thread assembly from multiple
  author files including cross-author replies; presence TTL; tracked-changes and comment import
  against real-Word fixtures.
- E2E: enable suggesting mode, type and delete, close and reopen the project, and confirm the
  suggestions survive with attribution (the renderer-persistence rule — this repo has caught
  stale-plugin-state bugs only at this layer); accept-all and confirm clean text; simulate a
  collaborator by writing a second author's review file directly and confirm the thread appears
  via the watcher without reopening.
- Manual: export a suggested-and-commented chapter to `.docx`, open in real Word — changes appear
  in Word's review pane with the right authors; edit with Word tracked changes, import back, and
  confirm they arrive as suggestions.
