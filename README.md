# The Pub

An IDE-fashioned story planning and editing tool: VS Code's shell ergonomics, Word-grade
formatting, and the notes a long story needs, in one desktop app.

## What works today

Phase 1 built the editing shell, Phase 2 added story records, Phase 3 the two planning views,
Phase 4 maps, Phase 5 AI assistance, Phase 6 remote projects, Phase 7 Word import and export, and
Phase 8 OneDrive — which completes the original brief. `docs/ROADMAP.md` covers what's grown out
of it since: notes attached to a document, cross-references and a table of contents, and
footnotes are shipped; templates, citations, and non-fiction project types are still ahead.

- **Dockable panes.** Tabs, splits and drag-to-dock, with any group tearable into its own OS
  window that docks independently. Torn-off panes share the main window's editor instances and
  undo history, so nothing is lost by moving a document to a second monitor.
- **Projects are folders.** Open any folder; The Pub keeps its own data in `.thepub/` beside
  your manuscript and never takes the files hostage.
- **File tree** with lazy loading, live updates when files change outside the app, and
  create/rename/reveal/move-to-trash.
- **Rich text editor** on TipTap: fonts, sizes, colour, highlight, bold/italic/underline/strike,
  super/subscript, alignment, indentation, line and paragraph spacing, lists, tables, images,
  and find/replace within a document. The toolbar's font and size boxes suggest presets but take
  anything — any installed face by name, any size down to the half-point — and page margins are
  set per side, Word-fashion.
- **Fonts you import.** A `.ttf`/`.otf`/`.woff`/`.woff2` dropped into the project (Styles panel →
  *import font…*) is copied into `.thepub/fonts/`, so it travels with the project to other
  machines, servers and OneDrive, and loads there over the same protocol as images. Word export
  names the family — it cannot embed the file, so a reader without the font installed sees a
  substitute, and the panel says so.
- **Named styles**, Word-style. Documents store a style id, not a copy of its formatting, so
  editing "Chapter Title" restyles the whole manuscript at once. Styles inherit through a
  `based on` chain and set the style of the following paragraph.
- **Cross-references and a table of contents**, built on one computed-text node so a reference
  reads as an ordinary part of the sentence: click one and it jumps to the heading it names, and
  a refresh replaces a table of contents in place rather than duplicating it. A style can opt into
  the contents independently of whether it renders as a heading.
- **Footnotes**, edited in a popover right where the marker sits — no separate window, and cutting
  or pasting the marker carries its note with it. Numbering is never stored, only computed from
  where the markers fall, and a read-only endnotes region below the manuscript lists every note in
  order. They export as real Word footnotes and import back the same way.
- **Autosave** that waits for a pause in typing but never longer than five seconds, writes
  atomically so a crash cannot leave a half-written file, refuses to clobber a file that changed
  underneath it, and flushes before the window closes.
- **Version history** you can open. Previous versions are kept as you write and thinned over
  time (everything from the last day, hourly for a week, daily beyond that); the History panel
  lists them, reads any one of them, and shows what changed against the document as it stands —
  paragraphs added, removed and moved, and the words within an edited one. Restore over the
  document or into a new file beside it. Restoring keeps what it replaced, including anything
  unsaved in the editor at the time, so it is not a one-way door.
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
- **Notes** attached to a span of text, in their own dock panel rather than inline in the prose.
  A note is anchored to the exact text it was written against; editing around it keeps the anchor,
  and rewriting the anchored text itself orphans the note without deleting it — the panel offers
  the nearest matching text as a candidate to re-attach it to, the same way a mention suggestion
  is offered rather than applied.
- **A storyboard and a timeline over the same beats.** The board holds cards in the order the
  story is *told*, dragged between columns you name; the timeline holds them in the order they
  *happen*. Those orders differ exactly when there is a flashback — which is why both views
  exist, and why they are two orderings of one set of records rather than two things to keep in
  step. A beat can name who is in it, carry a status, and link to the paragraph it covers. The
  timeline runs left to right, or top to bottom if you prefer — the choice is remembered.

Name scanning is deliberately conservative — three characters minimum, capitalised names matched
case-sensitively, per-record and per-alias switches, and a dismissal for anything that still
slips through — because a noisy suggestion list is how a feature like this gets turned off.

- **Maps** you draw or import: start from an image — a scan, a rendered map, a photograph of a
  sketch — or from a blank sheet, then add markers, routes, regions and labels over it, panned and
  zoomed, in vectors rather than pixels. The drawing stays editable whatever it sits on, and the
  background can be swapped or dropped later without moving anything already placed. A marker can
  name the location record that describes the place *and* open a map of its own, so a world map, a
  city map and the location pane are three views of one place rather than three copies of it.
  Markers can be drawn as any of twenty glyphs — cities, towns, castles, towers, bridges, forests,
  mountains, ruins, harbours and the rest — and dragged to a new spot without losing what they are
  linked to. Stroke width and region fill are yours to set, and stay with the shape.

- **AI assistance** from Anthropic, OpenAI, Hugging Face or a local LM Studio server, with as
  many conversations as you like. Ask about the selection or the whole document, watch the reply
  stream in, and insert it into the manuscript as an ordinary, undoable edit. Keys are yours:
  they are encrypted into the app's own data directory, never the project folder, and no channel
  hands one back to the interface.

- **An assistant that drafts, and never commits.** With the agent turned on it can search the
  project, propose prose edits as suggestions, and draft story records — one character, or a whole
  ensemble asked for as a group ("a crew of eight, no two from the same town, exactly one lying
  about why they signed on") and checked against those constraints before any of it is written.
  What it writes arrives as a *draft*: a real record you can search, mention and link to a beat,
  visibly marked, that you accept or discard. Accepting is the only thing that makes it yours —
  and once you have, the assistant cannot change it again. Researched citations come in the same
  way and say so on the card: it cannot browse, so a reference it attributes is unverified until
  you have checked it.

- **Projects on a server.** Open a project over SFTP or FTP and everything works unchanged —
  the tree, the editor, autosave, snapshots, search, records, maps. Saved servers keep their
  credentials encrypted on this machine, outside any project folder, and an SSH server has to prove
  its identity before anything is sent to it: you accept its fingerprint once, and if it ever
  changes, The Pub stops and tells you rather than carrying on.

- **Projects in OneDrive.** The same, over Microsoft Graph: sign in once in your own browser and a
  folder in your drive becomes a project. Changes made on another device arrive through Graph's
  delta feed rather than by re-listing the manuscript every few seconds, and a file too large for a
  single request — a map background, a photograph — uploads in chunks. Signing in needs an Azure app
  registration of your own; see below.

- **Word documents in and out.** Import a `.docx` and its headings, indents, spacing, alignment,
  lists, tables, links and images come with it — and its named styles are matched against the
  project's own rather than duplicated, so an imported "Heading 1" *is* your Heading 1. Export one
  chapter or the whole manuscript into a single file, page-broken between chapters, with the
  styles written into the file so it stays as editable in Word as it was here. Footnotes round-trip
  as real Word footnotes; anything that still cannot come across — comments, tracked changes,
  endnotes — is named in the import summary rather than dropped in silence.

- **A Manuscript panel** for the book as one ordered thing — front matter, parts and chapters,
  separate from the file tree because order here is something you set, not whatever the
  filesystem hands back. The binder starts empty; nothing is inferred from what's on disk. Drag
  chapters between parts or reorder with four buttons that reach every position without a mouse.
  A document renamed or moved outside the app stays resolved; one that's genuinely gone shows as
  missing without losing its place, and relinks in place once you point it at a replacement.
  Compile turns the structure into a `.docx` in one step — part titles become headings on their
  own page, and anything that couldn't be found is named alongside what compiled.

In-story time is free text — "Day 3", "Third Age 2941", "1917-04-02" — because invented calendars
are the norm. A label that reads unambiguously sorts the timeline for you; anything else keeps
the position you dragged it to, rather than being guessed at.

File names are checked against Windows' rules on every platform, not just on Windows. A name like
`Chapter: One` is perfectly legal on Linux and impossible on Windows, and a project written on one
is routinely opened — or served over SFTP — on the other, so the name is refused where it is typed
rather than where it fails. OneDrive forbids the same characters, so the check that exists for
Windows' sake is also what keeps a name from being rejected by the drive after it is typed.

## Setting up OneDrive

OneDrive needs an app registration of your own — The Pub does not ship one. A client id baked into
a desktop binary is a public value that anyone can lift and spend someone else's tenant quota with,
and it cannot be rotated without shipping a new build; it is the same reasoning as the AI keys, and
the same answer.

In the [Azure portal](https://portal.azure.com), under **App registrations**:

1. **New registration** — any name; supported account types decide who can sign in.
2. **Authentication → Add a platform → Mobile and desktop applications**, redirect URI
   `http://localhost`. Any port on loopback is then accepted, which is what lets the sign-in come
   back to the app without a fixed port.
3. Copy the **Application (client) ID** into The Pub's connect dialog, then press *sign in*.

The app asks for `Files.ReadWrite`, `offline_access` and `User.Read` — your drive, a refresh token
so you are not signing in every hour, and your account name to show back to you. No client secret is
involved: sign-in uses PKCE, which is what a desktop app is supposed to use because it cannot keep a
secret. The refresh token is encrypted into the app's own data directory, never a project folder,
and no channel hands it to the interface.

## Running it

```sh
npm install
npm run dev        # development, with hot reload
npm run build      # typecheck and build
```

## Releasing

```sh
npm run package    # an unpacked app in release/, for this platform
npm run dist       # the installers configured for this platform
```

`--dir` packing works on any host, including cross-platform: a Windows `The Pub.exe` builds
correctly from Linux. **Installers do not cross platforms.** The NSIS installer shells out to Wine
when built anywhere but Windows, the macOS DMG can only be built on macOS, and neither is
code-signed here — an unsigned Windows installer shows a SmartScreen warning, and an unsigned macOS
build has to be opened from the context menu the first time. Signing needs certificates that only
whoever ships the app can hold.

So a real release means running `npm run dist` on each target platform, or on a machine with Wine
for the Windows one.

| | Builds on | Needs |
|---|---|---|
| Windows app (`--dir`) | any host | — |
| Windows NSIS installer | Windows, or Linux with Wine | Wine off-Windows; a certificate to sign |
| macOS `.dmg` / `.zip` | macOS only | a Developer ID to sign and notarise |
| Linux AppImage / deb | Linux | — |

The application icon is `resources/icon.png`, with its vector source beside it; electron-builder
derives every platform's format from it.

## Tests

```sh
npm run typecheck    # main, renderer and e2e projects
npm test             # unit tests (vitest)
npm run e2e          # end-to-end tests driving the real app (Playwright + Electron)
npm run e2e:packaged # the same, against a packaged build — run `npm run package` first
```

On a headless machine, run the end-to-end tests under a virtual display: `xvfb-run -a npm run e2e`.

The packaged suite covers only what packaging changes — the asar archive, the production
dependencies inside it, and the real executable's own profile directory. Everything else is already
exercised against the development build, including the loopback renderer server and the production
content-security-policy, because the test harness sets no `ELECTRON_RENDERER_URL`.

**The remote backends are tested against real servers, not fakes.** They are almost entirely
protocol handling, so a fake would only confirm that the fake agrees with itself. FTP runs against
`ftp-srv`; SFTP runs against `ssh2.Server` — the server half of the library the app already uses as
a client, so no extra dependency, and the tests exercise the same crypto the release ships. Both
serve a real temporary directory, and the files that appear in it are the assertion. Each adapter
has a suite of its own as well as the end-to-end one that drives the whole app, and the difference
matters: the end-to-end suites walk the path an author walks, while the adapter suites are where a
dropped connection, an unreachable server and a refused host key can be arranged deliberately. Every
defect found in these backends so far has been found by the second kind.

**Creating things is tested by clicking the buttons.** For a long time it was not, and the cost was
high: every suite created documents, maps, records and beats by calling the zustand stores through
the test hook, so eight create flows that had been dead since the day they were written stayed green
all the way through packaging and release work. Anything an author reaches by clicking is now
reached the same way in `e2e/create.spec.ts` and its neighbours, and `noNativeDialogs.test.ts` fails
the build if `window.prompt` — which Electron does not implement, and which was the cause — comes
back.

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
│  ├─ onedrive/  OAuth, tokens and Graph requests — no Electron, so all testable
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

**Everything reaches the filesystem through `VfsAdapter`.** Local, SFTP, FTP and OneDrive backends
all satisfy it, so no feature above knows which one a project is on. Backends that cannot report
changes are wrapped in a polling watcher by the registry, so every consumer calls `watch`
unconditionally — OneDrive opts out of that by reporting `watch: true` and using Graph's delta feed,
which is one request per tick instead of one per folder.

**A remote save never deletes the previous version.** Remote writes are atomic — a temporary
sibling, then a rename over the target — but SFTP, FTP and OneDrive servers all commonly refuse to
rename onto a name that exists. The fallback moves the existing file *aside* and removes it only
once the replacement is in place. Deleting first is simpler and was what this did originally, but it
assumes the rename failed *because* the destination existed: a rename refused for any other reason —
a lock, a permission, a throttled account — would then delete the previous version and fail anyway,
and the chapter that was on the server a second ago would be gone. If even putting it back fails,
the error names the file it is safe under.

**A dropped connection fails the save rather than stalling it.** `ssh2` abandons a request that was
in flight when the channel died — no callback, no error, nothing — so an autosave interrupted by the
network going away used to neither finish nor fail: it waited forever, and so did everything holding
the document. Each SFTP request is now raced against the session, and losing the connection rejects
whatever was outstanding. The next call reconnects; the one that was in flight does not retry, which
is a real difference from the FTP backend and left alone deliberately rather than changed without
evidence.

**SFTP checks who it is talking to.** SSH encrypts a channel from the first exchange, but encryption
says nothing about *who* is on the other end: for several phases this client accepted whatever host
key it was handed, so anything able to answer on the host and port got an encrypted session with the
author and was then handed the password. Host keys are now checked against a `known_hosts.json` in
the app's own data directory, and a server nothing is known about is refused like any other — the
refusal happens during the key exchange, so no username and no password is ever sent to a server
that has not proved who it is. Accepting a fingerprint is a deliberate act in the connect dialog,
next to the `SHA256:…` string in the format `ssh-keygen -lf` prints, so it can be compared against
one obtained another way.

There is no trust-on-first-use here, and that is the considered part. Accepting the first key seen
would guard against an attacker who turns up later while being wide open to one already in place,
and the author would never learn a decision had been made for them. A key that has *changed* is a
louder refusal naming both fingerprints, and it can only be accepted by someone who reads it. Keys
are matched by algorithm, so a server that holds both an Ed25519 and an RSA key does not cry wolf
when the library's preference shifts. The store is plain JSON on purpose: a fingerprint is not a
secret, it is a value its owner is meant to be able to read — what matters is that nothing can
*write* it, which is what `userData` and a 0600 mode give, and it is the same reasoning behind
OpenSSH's own plaintext `known_hosts`.

**A stat that fails is not a file that is missing.** This is the same bug in three places, and it is
worth naming because it looks so harmless. `RemoteAdapter.delete` asks whether a path is there and
returns quietly when it is not, which is right for a file already gone — so a backend whose `stat`
answers "not there" for *any* failure turns a delete against an unreachable server into a reported
success. The row leaves the tree, and the chapter is still on the server. SFTP had this and was
corrected once a test server existed to unplug; FTP had it until the same was true for FTP; OneDrive
never did, because Graph says plainly when something is a 404. What each backend now checks is that
the *server said so* — a reply code naming the path as unavailable, never a connection that failed —
and the list is of what counts as absence rather than what counts as an error, so an answer nobody
anticipated fails loudly instead of quietly meaning "gone". FTP keeps two known imprecisions: it
answers 550 both for a path that is absent and for one it will not let you read, and there is no way
to tell those apart.

Getting this wrong in the other direction is just as easy. The first attempt here treated only 550
as absence, which is textbook and which no unit test objected to — and it made creating a project on
a server impossible, because the first thing an open does is ask about `.thepub/project.json` before
`.thepub` exists, and `ftp-srv` answers that with a 451. The end-to-end suite caught it; the adapter
suite had simply encoded the same wrong assumption as the code.

**FTP mtimes come from parsing what `ls` prints, and that is not a detail.** A server that speaks
MLSD reports an exact timestamp; most do not, and answer `LIST` with the columns of a Unix listing,
where `basic-ftp` hands back the date as the raw string it found. Left unparsed that became a zero —
and since the polling watcher decides that a file has changed by noticing that its mtime differs
from the last poll, every file claiming the epoch meant no edit made on another machine was ever
noticed, and the search index never caught up with it. The listing form is parsed now, which buys a
resolution of one minute and an unknown timezone. Both are survivable because nothing in this
codebase reasons about the absolute instant — the indexer, the watcher and the conflict check all
*compare* two readings — but a minute is too coarse for the one that decides whether somebody else
edited your chapter while you had it open, so `stat` asks the server directly with `MDTM`.

**The operating system is only asked about files it can see.** A project's root is a directory on
this machine for a local project and a URI for one on a server, and resolving a project-relative
path against a URI produces a path under the working directory that names nothing. Deleting used to
do this and got away with it: the trash call failed, the fallback ran, and the file went — correct
behaviour resting entirely on an error. Revealing did not get away with it, and silently handed a
file manager an address assembled out of a URI. Both now branch on whether the project is local, the
renderer is told which it is so the menu offers only what applies, and the delete on a server is
labelled `Delete` rather than `Move to Trash`, because there is no trash on a server and an author
who goes looking in a wastebasket that was never involved finds out too late.

**A packaged app is a different program, and is tested as one.** Main and preload move inside
`app.asar`, the six runtime dependencies the main bundle imports by name come from a pruned
production `node_modules` inside that archive, and `userData` moves from `the-pub` to `The Pub`.
That last one surprises people: saved servers, AI keys and recent projects from a development run do
not appear in a packaged one, and secrets encrypted by one binary cannot be decrypted by the other,
because `safeStorage` is keyed to the application's identity with the OS keychain. Both stores
already treat an undecryptable secret as absent, so nothing breaks — it just looks like the keys
went missing. `e2e/packaged.spec.ts` drives the real artifact and covers exactly this delta.

**Images are addressed by project, not by path.** The renderer has no `file://` access, so images
travel over a custom `pub-asset://` scheme whose urls name a project by an opaque token plus a
project-relative path. Main resolves the token to the open project and serves the bytes through that
project's own backend — which is what makes an image work on a manuscript kept on a server, where
the old form (a base64 absolute filesystem path) could only ever resolve locally. A token only
resolves while its project is open, so a hand-edited `src` cannot read from a project that is not on
screen. Urls in the older form are still served, because documents written before the change contain
them.

**Nothing the renderer can reach holds a credential.** Server passwords, key passphrases, AI keys
and the OneDrive refresh token all live encrypted in the app's own data directory, and every channel
that touches them returns a boolean or an account name instead. The OneDrive access token exists
only in main-process memory, and one cache holds it — Microsoft rotates the refresh token on every
use, so two caches would race to spend it and the loser would be signed out.

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
