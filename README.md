# The Pub

An IDE-fashioned story planning and editing tool: VS Code's shell ergonomics, Word-grade
formatting, and the notes a long story needs, in one desktop app.

## What works today

This is Phase 1 — the editing shell that everything else is built on.

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

Later phases add character, location, timeline, storyboard and map panes; AI assistance
(Anthropic, OpenAI, Hugging Face, LM Studio); OneDrive/FTP/SFTP projects; and DOCX import and
export. The file system, index and data model are already built as the abstractions those need.

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

## How it fits together

```
src/
├─ shared/     types, zod schemas and pure logic used by both processes
│  ├─ ipc/     the typed channel contract both sides derive from
│  ├─ model/   the on-disk formats: manifest, document, styles, layouts
│  └─ pm/      ProseMirror JSON utilities (text extraction, word count)
├─ main/       privileged process: files, search index, snapshots, windows
│  ├─ vfs/     the filesystem abstraction every feature is written against
│  ├─ services/  project session, documents, search, snapshots, layouts
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

**Everything reaches the filesystem through `VfsAdapter`.** The local backend is the only one
implemented, but the tree, editor, autosave and indexer are written against the interface, and
the registry already emulates change events for backends that can't watch.

**The search index is a cache, never a source of truth.** Delete `.thepub/index.db` and reopening
the project rebuilds it.
