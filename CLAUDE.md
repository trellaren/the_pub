# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repository.

## What this is

The Pub — an Electron desktop app for writing and planning long fiction (and, per
`docs/ROADMAP.md`, growing to serve essays/theses/papers too): a dockable IDE-style shell, a
Word-grade rich text editor, story records, a storyboard/timeline, maps, AI assistance, and
Word/OneDrive/SFTP/FTP interop. Read `README.md` first — it is long, narrative, and answers most
"why is this built this way" questions before you need to ask them. This file is the short,
task-oriented complement to it.

Stack: Electron + electron-vite, React 19, TypeScript, Zustand, TipTap 3 (ProseMirror), Zod.

## Commands

```sh
npm run dev          # electron-vite dev, hot reload
npm run typecheck    # tsc --noEmit across main, renderer and e2e tsconfigs — no bundled `lint`
npm test             # vitest run (unit tests, colocated *.test.ts)
npm run test:watch   # vitest watch mode
npm run e2e          # Playwright driving the real built app (run `npm run build` first)
npm run build        # typecheck + electron-vite build
bash ci/run-checks.sh --skip-package   # the pre-merge gate; see below
```

On a headless box, e2e needs a virtual display: `xvfb-run -a npm run e2e`.

**Before considering any change done**, run `npm run typecheck`, `npm test`, and — for anything
touching the editor, IPC, or a user-facing flow — the relevant `e2e/*.spec.ts` file(s) under
`xvfb-run`. GitHub Actions is deliberately off for this repo (see `ci/README.md`); `bash
ci/run-checks.sh` is the actual gate, and it runs against a **fresh clone of committed history**,
not your working tree — so uncommitted or unstaged changes are invisible to it. Run it (at least
with `--skip-package`, which skips the slow packaging/packaged-smoke stages) before opening or
updating a PR.

## How it fits together

```
src/
├─ shared/     types, zod schemas and pure logic used by both processes
│  ├─ ipc/     the typed channel contract both sides derive from
│  ├─ model/   the on-disk formats: manifest, document, styles, layouts, records
│  └─ pm/      ProseMirror JSON utilities (text extraction, word count, mention scanning)
├─ main/       privileged process: files, search index, snapshots, windows
│  ├─ vfs/     the filesystem abstraction every feature is written against
│  ├─ docx/    Word conversion, both directions, with no knowledge of a project
│  ├─ onedrive/  OAuth, tokens and Graph requests — no Electron, so all testable
│  ├─ services/  project session, documents, search, records, snapshots, layouts
│  └─ server/  loopback server for the packaged renderer
├─ preload/    the single, allow-listed bridge between the two
└─ renderer/   React UI: dock shell, panels, editor, stores
```

`docs/ROADMAP.md` is the forward plan (phases, in dependency order, each meant to ship on its
own); `docs/phase-0-plan.md` is a worked example of how a phase gets scoped into a build plan.
Check the roadmap before adding a feature it already describes — the scoping decisions there
(desktop-only, no pagination engine, footnotes-not-page-geometry) are deliberate, not gaps.

## House rules this codebase actually enforces

These aren't aspirational — the existing code follows them, and tests exist to catch drift:

- **One text-walking implementation.** `shared/pm/extractText.ts`'s `forEachTextNode`/`nodeText`
  is the *only* place that turns ProseMirror JSON into text with offsets. Search snippets,
  mention ranges, word counts, and mark-application code all consume it rather than re-deriving
  text themselves. A second implementation drifts silently, and only on documents with hard
  breaks, lists, or (as of the `field`/`footnote` nodes) inline computed content.
- **Everything reaches the filesystem through `VfsAdapter`** (`src/main/vfs/`). Local, SFTP, FTP
  and OneDrive backends all satisfy the same interface; no feature above it knows which backend a
  project is on. New persistent state goes through it, not through `fs` directly.
- **One `FORMAT_VERSIONS` counter per file kind** (`src/shared/constants.ts`), each with its own
  entry in `MIGRATIONS` (`src/shared/model/migrate.ts`). A new node/mark type or on-disk shape
  change for a given kind bumps *that kind's* counter and adds a migration step — even a no-op
  one — so an older build doesn't silently drop content it doesn't understand when it re-saves a
  file. Import the kind-specific constant (`FORMAT_VERSIONS.document`, `.manifest`, …); the bare
  `FORMAT_VERSION` export is `@deprecated`, aliased to `.document` only, and a real bug class in
  this repo's history came from other kinds importing it by mistake — check for that specifically
  after touching any model file.
- **Records link by id, never by name or path.** A mention mark holds a record id; a beat's cast
  list and scene link are ids. This is what makes renaming a character or moving a chapter on disk
  free.
- **Word export and import are asymmetric on purpose.** Export goes through the `docx` library
  (a producer already proven against real Word); import parses OOXML directly against hand-built
  fixtures in `src/main/docx/fixtures.ts` written the way Word actually writes files — not
  round-tripped only through our own exporter, which would just prove the importer agrees with
  itself.
- **Nothing the renderer can reach holds a credential.** Server passwords, AI keys, OneDrive
  tokens: encrypted in the app's own data directory via `safeStorage`, never in a project folder,
  never returned over an IPC channel as anything but a boolean/account-name.

## Conventions

- **No comments explaining *what* code does** — names carry that. A comment is earned only by a
  non-obvious *why*: a hidden constraint, a workaround, an invariant a future reader could easily
  break. The existing codebase is a good calibration reference — skim any file in `shared/` before
  writing new comments.
- **Tests are colocated** (`foo.ts` next to `foo.test.ts`), vitest, and prefer plain data fixtures
  over instantiating a live `Editor`/`EditorView` where the logic under test is pure (see
  `shared/pm/*.test.ts`, `renderer/panels/editor/extensions/namedStyles.test.ts`).
- **E2E tests** (`e2e/*.spec.ts`) drive the real Electron app via Playwright — see `e2e/helpers.ts`
  for `launch`/`openProject`/`createDocument`/`cleanup`. Prefer `locator.press()` over
  `page.keyboard.press()` for typing under load (it re-focuses per keystroke); wait for typed text
  to land (`toContainText`) before further keyboard-driven selection; when clicking a specific
  spot matters (e.g. avoiding an overlapping popover), pass an explicit `position` rather than
  relying on a text-matched locator's auto-computed center.
- **Renderer additions that persist across a project close/reopen need an e2e test proving it**,
  not just a unit test of the pure logic — this repo has caught real bugs (stale plugin state, a
  click-to-jump position resolved wrong) only at that layer.
- New node/mark types added to the editor schema need updating in *all* of: the TipTap extension
  (`renderer/panels/editor/extensions/`), `shared/pm/extractText.ts`'s `INLINE_TYPES` if inline,
  `main/docx/toDocx.ts`'s `EDITOR_NODE_TYPES`/`EDITOR_MARK_TYPES` (and export handling), and
  `main/docx/fromDocx.ts` (import handling) — plus a `FORMAT_VERSIONS`/`MIGRATIONS` bump. Grep for
  an existing node like `field` or `footnote` as a template; the "closed world" test in
  `main/docx/toDocx.test.ts` (`emits no node or mark type this build cannot render`) will fail
  loudly if a type is missed.

## Git / PR workflow

- Follow whatever branch and PR instructions are given for the session; there's nothing
  repo-specific beyond the general safety rules (never force-push or skip hooks without being
  asked, review staged diffs, run `git status` before anything that could discard work).
- Draft PRs are the default when a workflow calls for opening one; subscribe to their activity and
  drive CI to green rather than leaving a failure unaddressed.
- `bash ci/run-checks.sh` (or `--skip-package` for a faster loop) is the real gate — it clones
  fresh, so it will catch a file you edited but forgot to `git add`.
