# The Pub

An IDE-fashioned story planning and editing tool: VS Code's shell ergonomics, Word-grade
formatting, and the notes a long story needs, in one desktop app.

## What works today

Phase 1 built the editing shell, Phase 2 added story records, Phase 3 the two planning views,
Phase 4 maps, Phase 5 AI assistance, Phase 6 remote projects, and Phase 7 Word import and export.

- **Dockable panes.** Tabs, splits and drag-to-dock, with any group tearable into its own OS
  window that docks independently. Torn-off panes share the main window's editor instances and
  undo history, so nothing is lost by moving a document to a second monitor.
- **Projects are folders.** Open any folder; The Pub keeps its own data in `.thepub/` beside
  your manuscript and never takes the files hostage.
- **File tree** with lazy loading, live updates when files change outside the app, and
  create/rename/reveal/move-to-trash.
- **Rich text editor** on TipTap: fonts, sizes, colour, highlight, bold/italic/underline/strike,
  super/subscript, alignment, indentation, line and paragraph spacing, lists, tables, images,
  and find/replace within a document.
- **Named styles**, Word-style. Documents store a style id, not a copy of its formatting, so
  editing "Chapter Title" restyles the whole manuscript at once. Styles inherit through a
  `based on` chain and set the style of the following paragraph.
- **Autosave** that waits for a pause in typing but never longer than five seconds, writes
  atomically so a crash cannot leave a half-written file, refuses to clobber a file that changed
  underneath it, and flushes before the window closes.
- **Snapshots** of previous versions, thinned over time (everything from the last day, hourly
  for a week, daily beyond that).
- **Project-wide search** over document text and filenames, with results that jump to the exact
  paragraph.
- **Persisted layouts** — the arrangement of a project comes back when you reopen it, popout
  windows included, and named presets can be saved and reapplied.
- **Character and location records**, with aliases, a colour, free-form details you name
  yourself, and notes. Both kinds are the same record and share one panel.
- **Mentions.** Type `@` to link a name to a record, or let The Pub *suggest* the links by
  finding names in the prose. A suggestion is only ever an index entry — it never edits your
  document. Confirming one writes a mark that carries the record's id, so renaming a character
  never touches a single manuscript file, and the name in the prose stays ordinary text that
  search, word count and export treat like any other.
- **Backlinks.** Every record lists each paragraph it appears in, and clicking one opens the
  document there.
- **A storyboard and a timeline over the same beats.** The board holds cards in the order the
  story is *told*, dragged between columns you name; the timeline holds them in the order they
  *happen*. Those orders differ exactly when there is a flashback — which is why both views
  exist, and why they are two orderings of one set of records rather than two things to keep in
  step. A beat can name who is in it, carry a status, and link to the paragraph it covers.

Name scanning is deliberately conservative — three characters minimum, capitalised names matched
case-sensitively, per-record and per-alias switches, and a dismissal for anything that still
slips through — because a noisy suggestion list is how a feature like this gets turned off.

- **Maps** you draw: markers, routes, regions and labels, panned and zoomed, in vectors rather
  than pixels. A marker can name the location record that describes the place *and* open a map
  of its own, so a world map, a city map and the location pane are three views of one place
  rather than three copies of it.

- **AI assistance** from Anthropic, OpenAI, Hugging Face or a local LM Studio server, with as
  many conversations as you like. Ask about the selection or the whole document, watch the reply
  stream in, and insert it into the manuscript as an ordinary, undoable edit. Keys are yours:
  they are encrypted into the app's own data directory, never the project folder, and no channel
  hands one back to the interface.

- **Projects on a server.** Open a project over SFTP or FTP and everything works unchanged —
  the tree, the editor, autosave, snapshots, search, records, maps. Saved servers keep their
  credentials encrypted on this machine, outside any project folder.

- **Word documents in and out.** Import a `.docx` and its headings, indents, spacing, alignment,
  lists, tables, links and images come with it — and its named styles are matched against the
  project's own rather than duplicated, so an imported "Heading 1" *is* your Heading 1. Export one
  chapter or the whole manuscript into a single file, page-broken between chapters, with the
  styles written into the file so it stays as editable in Word as it was here. Anything that
  cannot come across — footnotes, comments, tracked changes — is named in the import summary
  rather than dropped in silence.

In-story time is free text — "Day 3", "Third Age 2941", "1917-04-02" — because invented calendars
are the norm. A label that reads unambiguously sorts the timeline for you; anything else keeps
the position you dragged it to, rather than being guessed at.

File names are checked against Windows' rules on every platform, not just on Windows. A name like
`Chapter: One` is perfectly legal on Linux and impossible on Windows, and a project written on one
is routinely opened — or served over SFTP — on the other, so the name is refused where it is typed
rather than where it fails.

Still to come: OneDrive projects. The `VfsAdapter` abstraction they need is already built and
proven by the SFTP and FTP backends; what is missing is an Azure app registration, which has to be
created by whoever ships the app.

## Running it

```sh
npm install
npm run dev        # development, with hot reload
npm run build      # typecheck and build
npm run package    # build an unpacked app in release/
```

## Tests

```sh
npm run typecheck  # main, renderer and e2e projects
npm test           # unit tests (vitest)
npm run e2e        # end-to-end tests driving the real app (Playwright + Electron)
```

On a headless machine, run the end-to-end tests under a virtual display: `xvfb-run -a npm run e2e`.

Before merging, run the whole suite against a clean clone of committed history:

```sh
bash ci/run-checks.sh
```

GitHub Actions is switched off for this repository on purpose, so that script is the gate rather
than a workflow. See [`ci/README.md`](ci/README.md).

## How it fits together

```
src/
├─ shared/     types, zod schemas and pure logic used by both processes
│  ├─ ipc/     the typed channel contract both sides derive from
│  ├─ model/   the on-disk formats: manifest, document, styles, layouts, records
│  └─ pm/      ProseMirror JSON utilities (text, word count, mention scanning)
├─ main/       privileged process: files, search index, snapshots, windows
│  ├─ vfs/     the filesystem abstraction every feature is written against
│  ├─ docx/    Word conversion, both directions, with no knowledge of a project
│  ├─ services/  project session, documents, search, records, snapshots, layouts
│  └─ server/  loopback server for the packaged renderer
├─ preload/    the single, allow-listed bridge between the two
└─ renderer/   React UI: dock shell, panels, editor, stores
```

A few decisions worth knowing before changing things:

**Documents are ProseMirror JSON, and carry their own id.** A `.pubdoc` stores a `docId` inside
the file rather than deriving identity from its path, so renaming or moving a chapter in Finder
doesn't break the layout that references it, its snapshots, or anything else pointing at it.

**The renderer is served over loopback HTTP, not `file://`.** Pages loaded from `file://` have an
opaque origin, and a torn-off pane must be able to share the opener's JS context. Serving the
built renderer from `127.0.0.1` on an OS-assigned port behind a per-launch path token gives the
app a real origin — which is also what makes its `'self'` content-security-policy mean anything.

**Everything reaches the filesystem through `VfsAdapter`.** Local, SFTP and FTP backends all
satisfy it, so no feature above knows which one a project is on. Backends that cannot report
changes are wrapped in a polling watcher by the registry, so every consumer calls `watch`
unconditionally. Remote writes are still atomic: a temporary sibling, then a rename over the
target, with a delete-then-rename fallback for servers that refuse to replace.

**The search index is a cache, never a source of truth.** Delete `.thepub/index.db` and reopening
the project rebuilds it. That is also the migration strategy: the schema carries a version, and a
mismatch drops the derived tables so the next open refills them.

**There is one text path, and every offset outside it means the same thing.** Block text is built
by a single walker in `shared/pm/extractText.ts`, and everything that leaves it — search
snippets, mention ranges, the offsets written to the database — is in normalised block
coordinates. A second implementation of that normalisation would drift silently, and only for
documents with hard breaks or lists.

**Records link by id, everywhere.** A mention mark, a beat's cast list, a beat's scene link —
all ids. Renaming a character or moving a chapter in Finder cannot break any of them.

**A mention mark stores an id, never a name.** That is what makes renaming a character free: no
document is touched, and the backlinks re-point from the index without reading a single file.

**Word conversion is asymmetric, on purpose.** Export goes through the `docx` library and import
parses OOXML directly. The biggest risk when writing a `.docx` is producing a file Word refuses to
open, and there is no Word on the machine that builds this to check against, so that direction
uses a producer already proven against it. Reading is the opposite problem: a converter like
mammoth turns a document into HTML and throws away the styles, indents and spacing that are the
whole point here. Because a round-trip test would then only ever prove the importer against our
own exporter's idioms, the importer is also tested against hand-built fixtures written the way
Word writes — bare `<w:b/>` toggles, hanging indents, `w:jc="both"`, numbering split across two
parts.
