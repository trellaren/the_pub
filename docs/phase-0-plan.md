# Phase 0 — Format governance and stable identity

The build plan for the first phase of [`ROADMAP.md`](./ROADMAP.md). Nothing here is user-visible
except one new bar in the editor; the point of the phase is to stop losing data and to give the
later phases something to point at.

## Why now

`formatVersion` is stamped into every file Quoth writes — `src/shared/model/document.ts` and
nine sibling models — and read by nothing. `DocumentService.write` re-stamps `FORMAT_VERSION`
unconditionally.

`pmNodeSchema` is permissive on purpose ("the editor's schema is the authority on node shapes,
and the persistence layer must not reject documents produced by a newer extension set"), so an
older build parses a newer `.pubdoc` happily. But `createEditor` runs with
`enableContentCheck: true`; it drops node types it does not recognise, autosave then writes that
content back, and the stamp goes *down*. Every phase on the roadmap adds node types, so the
window for this to bite opens the moment the next phase ships.

## Part 1 — Migration framework

### `src/shared/model/migrate.ts` (new)

```ts
type MigrationStep = { from: number; to: number; up(raw: unknown): unknown }
const MIGRATIONS: Record<FileKind, MigrationStep[]>
function migrate(kind: FileKind, raw: unknown): {
  value: unknown
  migrated: boolean
  tooNew: boolean
}
```

`FileKind` covers `document`, `manifest`, `manuscript`, `entities`, `beats`, `maps`, `layouts`,
`chats` and `connections`. It ships with **zero migration steps** — the deliverable is the
machinery and the too-new guard, not a format change.

### `src/shared/constants.ts`

Add `FORMAT_VERSIONS = { document: 1, manifest: 1, … }` and `MIN_SUPPORTED_VERSIONS`. Keep
`FORMAT_VERSION` exported as `FORMAT_VERSIONS.document` for one release, so the ~15 existing call
sites do not all churn at once.

### `src/main/services/documentService.ts`

- `read` runs `migrate('document', raw)` **before** `pubDocumentSchema.parse`.
- `write` returns a new `{ ok: false, reason: 'format-too-new', diskVersion }` when the file on
  disk was written by a newer build. It already reads the previous contents to snapshot them, so
  the version check costs nothing extra.

### `src/shared/ipc/contract.ts` and `channels.ts`

Extend the `doc:write` discriminated union with the `format-too-new` case. The two files move in
lockstep; the `_InvokeChannelsMatch` compile-time guard catches it if they do not.

### `src/renderer/panels/editor/EditorPanel.tsx`

The existing `ConflictBar` — keep-mine / reload — gains a third state: read-only, "this file was
written by a newer version of Quoth". Unlike a conflict, this one offers no overwrite.

### `src/main/services/projectSession.ts`

`loadOrCreateManifest` today renames an unparseable manifest to `.corrupt-*`. That is right for
corruption and wrong for "newer". Route too-new through `migrate` and open the project
**read-only** instead, with `readOnly: boolean` on the open-project result.

## Part 2 — Stable ids in ProseMirror

Two mechanisms, deliberately distinct. A third — an inline atom `field` node for point insertions
— arrives in Phase 3, and should not be conflated with either of these.

| Need | Mechanism |
|---|---|
| Block identity — cross-references, contents targets, bookmarks | global attribute `blockId`, lazily allocated |
| Ranged annotation — notes, comments, citations spanning text | mark `anchor` carrying an `anchorId` |

### `extensions/blockIds.ts` (new)

Modelled on `namedStyles.ts`'s `addGlobalAttributes()`. An `appendTransaction` that:

- assigns a ULID **only** to blocks something references or the user bookmarks. Assigning one to
  every paragraph would bloat every `.pubdoc` on disk for no benefit;
- de-duplicates ids on paste and on `splitBlock` — the failure mode everyone who builds this
  hits, and the reason it needs a plugin rather than a default attribute value.

### `extensions/anchors.ts` (new)

A mark, following `mention.ts` closely, with `inclusive: false` and one deliberate divergence:
`keepOnSplit: true` where `Mention` sets `false`. Splitting a paragraph that carries a note
should leave the note attached to both halves.

### `src/shared/pm/anchors.ts` (new)

Pure, and a sibling of `mentions.ts`: `findAnchor`, `collectAnchorIds`, `anchorSurfaceText`.
Built on `extractRawBlocks`, `normalizeBlockText` and `forEachTextNode` from `extractText.ts`,
which already supply the raw↔normalised offset map needed to re-find a lost anchor by its text —
the recovery path Phase 2's orphaned notes depend on.

### `createEditor.ts`

Register `BlockIds` and `Anchors`.

### Not needed after all

The plan originally included making the History panel's diff insensitive to attribute-only
changes, so lazily-assigned ids would not read as edits. `diffBlocks` compares `TextBlock.text`
and nothing else, so attributes never reach it. No change required.

## Verification

- `bash ci/run-checks.sh` — typecheck, lint, vitest and Playwright, as CI runs it.
- New unit tests: migration round-trip with no steps registered; too-new detection; `findAnchor`
  after edits before, inside and after the anchored range; an anchor surviving a paragraph split;
  `blockId` de-duplication on paste.
- Manual: type a document, hand-edit its `.pubdoc` `formatVersion` to `99`, reopen. Expect the
  read-only bar — and confirm the file on disk is byte-identical afterwards.
- Manual regression: a History diff of an edited document shows no spurious paragraph changes
  from id assignment.
