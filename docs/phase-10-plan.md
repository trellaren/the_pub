# Phase 10 — Database-backed projects, and an agent that can act

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 10. It carries **two tracks that share no
code**: a fourth family of project backends, and the agentic half deliberately scoped out of
Phase 8. They are numbered together because they ship together; either can land first, and
nothing in one blocks the other. The one place they meet is optional and named at the end.

---

# Track A — Projects in a database

## Why

`VfsAdapter` (`src/main/vfs/types.ts`) is eleven methods over project-relative POSIX paths, and
local, SFTP, FTP and OneDrive all satisfy it. Nothing above it knows which backend a project is
on. A database is the backend that layer was always capable of and has never been asked for —
and it is the first one that is genuinely *better* than local disk at the things this app finds
hard:

- **Real atomic writes.** `writeFileAtomic` on FTP is a temp file and a rename with a window in
  between. In a database it is a transaction.
- **Cheap change detection.** `pollingWatch` diffs a full recursive `walk` every 15 seconds
  because FTP has nothing better. A database answers "what changed since revision N" with one
  indexed query, and Postgres can push it with `LISTEN`/`NOTIFY`.
- **A project that is one thing.** A `.thepub` folder synced by a consumer file-sync client is
  the source of most conflict reports; a row in a table is not half-copied.

## Part A1 — One `db` protocol, three dialects

`connectionProtocols` in `src/shared/model/connection.ts` gains **`'db'`** — one protocol, not
three. The VFS mapping is identical for every engine; only the SQL dialect differs, so the engine
is a field on the profile rather than a protocol of its own:

```ts
export const dbEngines = ['postgres', 'mysql', 'sqlite'] as const
// on connectionProfileSchema:
engine: dbEngineSchema.default('postgres'),
database: z.string().default(''),   // or, for sqlite, a file path in `host`
schema:  z.string().default('thepub')
```

Postgres and MySQL are servers a writing group or an institution already runs; SQLite is a single
portable file, and it needs no driver at all — `node:sqlite` is what `searchIndexService.ts`
already indexes with.

Drivers (`pg`, `mysql2`) are **lazily imported inside the dialect module**, so a writer who only
ever opens local folders never loads either, and neither reaches the renderer.

### The URI, and the migration it forces

`projectUri`/`parseProjectUri` hardcode `^(sftp|ftp|onedrive)://`. Both gain `db`. That regex is
load-bearing — recent projects, saved layouts and window titles all key off the URI it parses —
so it is the kind of change that must be made in the one place it lives, not pattern-matched
across call sites.

More consequential: an older build reading a connections file that contains a `db` profile fails
`connectionProtocolSchema`'s enum, and `ConnectionStore` treats an unparseable file as corrupt —
which would lose **every saved server**, not just the new one. So `FORMAT_VERSIONS.connections`
goes 1 → 2 with a no-op step in `MIGRATIONS.connections`, and the too-new guard opens it
read-only instead. This is the highest-value line in Track A.

## Part A2 — The storage schema

```sql
CREATE TABLE pub_meta  (key TEXT PRIMARY KEY, value TEXT)        -- schemaVersion, created
CREATE TABLE pub_files (
  path    TEXT PRIMARY KEY,      -- project-relative, POSIX, '' is the root
  kind    TEXT NOT NULL,         -- 'file' | 'dir'
  content BLOB,                  -- NULL for a dir
  size    INTEGER NOT NULL,
  mtime   INTEGER NOT NULL,
  rev     INTEGER NOT NULL       -- monotonic, from pub_rev
)
CREATE TABLE pub_changes (rev INTEGER PRIMARY KEY, path TEXT, type TEXT, at INTEGER)
```

Three decisions worth stating:

- **Directories are explicit rows, not inferred from path prefixes.** Inferring them is tidier
  until an author makes an empty folder, which then vanishes on reopen. `list()` stays a prefix
  query either way.
- **`rev` is a monotonic counter, and `pub_changes` is the watch feed.** This is what replaces a
  15-second recursive walk with `SELECT … WHERE rev > ?`. `pub_changes` is pruned to a bounded
  window; a watcher that has fallen further behind than the window re-syncs from scratch, which
  is exactly what `pollingWatch` does on its first tick anyway.
- **`pub_meta.schemaVersion` gets the same too-new guard as every file kind.** A database written
  by a newer build opens read-only rather than being "upgraded" by a build that does not know
  what it is looking at.

Multiple projects share one database by `schema`/table prefix, so a group can run one Postgres
and keep a manuscript per schema.

## Part A3 — `src/main/vfs/dbAdapter.ts`

One adapter, a `DbDialect` seam beneath it (`quoteIdent`, `upsertFile`, `listen`, `now`), and no
Electron import — the `src/main/onedrive/` rule, so it tests as pure logic.

One correctness note worth carrying, found while building it: a dialect whose placeholder is a
bare `?` binds parameters **by their position in the SQL**, so an `UPDATE` cannot reuse an
`INSERT`'s value list reordered. Getting that wrong shifts every column by one — and does it only
on SQLite and MySQL, passing cleanly against Postgres, whose `$n` says which value it means.

`caps`: `atomicRename: true` (a transaction), `preservesMtime: true`, `fastStat: true`,
`caseSensitive: true`, and `watch: true` **for Postgres only** — the registry already emulates
what a backend lacks, so MySQL and SQLite fall back to polling `pub_changes`, which is cheap
enough that the 15-second default can stay.

Secrets follow the existing rule without exception: the password or connection string lives in
`ConnectionStore`, encrypted via `safeStorage`, and no channel ever returns it. `hasSecret` is
the only thing the renderer learns.

## Part A4 — UI

`ConnectDialog.tsx` gains a `db` branch: engine, host/port/database/user (or a file path for
SQLite), schema name, and a **Test connection** button reusing `connections:test`. Creating a
project on an empty database runs the schema creation, announced plainly — silently creating
tables in someone's production database is not a thing to do quietly.

That announcement is load-bearing enough to be structural rather than a warning label. "Reachable
but holding no project" comes back from `connections:test` as its own field rather than as a
failure, because those are different answers; creating the tables is a separate channel reached
from a sentence naming the schema and the tables it is about to add; and opening a project on an
empty database *refuses*, so DDL is never a side effect of opening anything.

---

# Track B — Agentic assistance

## Why, and the one rule that makes it safe

Phase 8's model answers when asked. This track lets it *act*: search the manuscript, read a
document, look up a record, and propose changes. The scoping decision that makes that acceptable
is a single sentence, and everything below follows from it:

> **The agent never writes to a document. It proposes, and its proposals arrive as Phase 9
> suggestion marks.**

Accept/reject already exist, already round-trip to Word, already show attribution, and already
have an undo path through the ordinary editor command chain. An agent that edits directly would
need every one of those built again, worse. This is also why Track B depends on Phase 9 while
Track A depends on nothing.

## Part B1 — Tool use in the provider layer

`src/main/ai/providers.ts` currently builds one request shape for Anthropic and one for the
OpenAI-compatible three. Tools split the same way — `tools`/`tool_use` for Anthropic,
`tools`/`tool_calls` for the rest — so `buildRequest` gains a `tools` argument and one branch per
dialect, in the file that already exists to hold exactly this difference.

`deltaFrom` returns `string | null` today. It becomes a small union, because a tool call is not
text and must not be concatenated into the reply:

```ts
type StreamPart =
  | { kind: 'text'; text: string }
  | { kind: 'toolCall'; id: string; name: string; argsDelta: string }
```

`SseParser` is untouched — event framing is not what changed.

## Part B2 — The tool surface (`src/main/ai/tools.ts`)

Small, read-mostly, and every tool a thin wrapper over a service that already exists:

| Tool | Backed by |
|---|---|
| `searchManuscript` | `SearchIndexService.query` |
| `readDocument` | `DocumentService.read` |
| `listRecords` / `readRecord` | `EntityService`, `BeatService` |
| `listSources` | `SourceService` |
| `proposeEdit` | a Phase 9 suggestion, never a write |

Tools are declared once as zod schemas and serialised into each dialect from there, so a tool
cannot be described to the model in a shape the handler does not accept.

**Read tools run without asking. `proposeEdit` is the only one that touches a document, and its
output is reviewable by construction** — which is what makes a per-call consent prompt
unnecessary rather than merely tolerable. A step budget (default 12) bounds a run, and cancel
works through `AiRunner`'s existing `AbortController`.

## Part B3 — The agent loop (`src/main/ai/agentRunner.ts`)

Beside `aiRunner.ts`, not inside it: a plain send is one request, and an agent run is a loop over
requests with tool results appended between them. Merging them would put a loop in the path of
every ordinary message.

The run is recorded in the chat, not in a private log — `chatMessageSchema` gains an optional
`toolCalls: [{ id, name, args, result, at }]`, so what the agent did is readable months later
next to what it said. That is another on-disk shape change: `FORMAT_VERSIONS.chats` 2 → 3 (Phase
8 takes it to 2), with a no-op `MIGRATIONS.chats` step.

## Part B4 — Retrieval

"Which chapter did I describe the harbour in" is a semantic question, and the FTS index answers
it badly. `SearchIndexService` already owns `.thepub/index.db`, already stores one row per
top-level block, and already has a `SCHEMA_VERSION` whose bump forces a full rebuild. Add an
`embeddings` table keyed on the same block rows and bump it — the rebuild is the documented,
intended cost, and the index remains a pure cache that can be deleted at any time.

- **Vectors come from the embedded model** (Phase 8's `llama-server` serves `/v1/embeddings`),
  falling back to a hosted provider only if the writer has chosen one. Retrieval that silently
  ships the manuscript to a hosted embedder would undo the whole point of Phase 8.
- **Brute-force cosine over float32 blobs.** No vector index, no extension: a long novel is tens
  of thousands of blocks, which is milliseconds, and an ANN index would be a second thing to keep
  correct for a speedup nobody can perceive. Stated plainly here so the limit is a decision
  rather than a surprise.
- Embedding is incremental off the same mtime diff `syncAll` already uses, and disabled entirely
  when AI is off (Phase 8's `aiEnabled`) — no model, no embeddings, no background work.
- **Which model embeds is its own setting**, not the chat model: on a hosted backend they are
  different models entirely, and asking OpenAI to embed with `gpt-4o` is a 400 a writer would
  have no way to fix. `embedModel` on `AiSettings`, empty meaning the provider's default — so
  `FORMAT_VERSIONS.chats` goes 3 → 4 with another no-op step.
- **Nothing embeds behind the writer's back.** Loading gigabytes of weights, or posting a
  manuscript to a paid endpoint, happens because a person pressed a button. The index tops itself
  up on its own only where that costs nothing surprising — a local model that is already running,
  a local server that needs no key — and the panel reports coverage as a number, because a
  partially-indexed project that answers "you never mention it" is confidently wrong.

## Deliberately out of scope

MCP and third-party tool servers; agents that run unattended or on a schedule; multi-document
autonomous refactors; any tool that writes outside a document (creating records, moving files,
touching the manifest); and fine-tuning. Track A adds no cloud object stores (S3 is a blob store,
not a database, and would want its own adapter).

## Verification

- `bash ci/run-checks.sh`.
- Track A unit: the adapter driven against **`node:sqlite` in memory** — the whole `VfsAdapter`
  contract, plus empty-directory survival, atomic write rollback on a failed transaction, and
  `rev`-based change feeds including the fell-behind-the-window re-sync; dialect quoting per
  engine; URI parse/format round-trip for `db`; the connections migration and its too-new guard.
  Postgres and MySQL run the same shared suite behind an opt-in env var, following the
  `ftpTestServer.ts`/`sftpTestServer.ts` precedent of testing against a real server where one is
  cheap to obtain.
- Track B unit: tool schema → each dialect's wire shape; the streaming split of text from tool
  calls, including a tool call spread across chunk boundaries; the loop stopping at its step
  budget; `proposeEdit` producing valid suggestion marks and never a direct write; cosine ranking
  over fixed vectors.
- E2E: create a project on a SQLite-backed connection, write a document, reopen it, and confirm
  the content and an empty folder both survive; run an agent request against a stubbed provider
  that returns a scripted tool call and assert the result lands as a reviewable suggestion, not
  as text in the document.
- Manual: a project on a real Postgres, edited from two machines, with the second seeing the
  first's change through `LISTEN`/`NOTIFY` rather than a poll.
