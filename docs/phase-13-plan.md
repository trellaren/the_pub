# Phase 13 — Goals and statistics

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 13. Independent of every other phase: it
adds no node types, no marks and no export behaviour, and touches the editor only to learn when
typing starts and stops.

## Why, and why the data does not already exist

`countWords` is in `shared/pm/extractText.ts` and correct. `snapshotSchema` already carries a
`wordCount` next to a timestamp, so it is tempting to derive the whole feature from the snapshot
history and write no new storage at all.

That does not work, and it is worth being precise about why, because the tempting version fails
quietly:

- `SNAPSHOT_MIN_INTERVAL_MS` is ten minutes, so a short session can produce no snapshot at all.
- `SNAPSHOT_MAX_PER_DOC` is 50, and `snapshotService` prunes the oldest. A history that deletes
  its own beginning is not a history — the chart would silently lose January.
- Snapshots are per document. A day's work spread over six chapters is six unrelated series.
- Snapshots are disabled outright when `snapshotsEnabled` is false.

So the phase writes its own record. Snapshots stay what they are: a recovery mechanism, not a
measurement.

## Part 1 — What is recorded

### `.thepub/stats/<authorId>.json`

One file per author, single-writer by construction — the rule Phase 9 establishes for review
files, adopted here for the same reason: on a shared project, two people's writing days must not
race on one file. Without Phase 9 there is one file under a stable local id, and nothing changes
when Phase 9 lands.

**Daily rollups, not an event log.** The unit anyone asks about is a day ("how much did I write
on Tuesday"), an event log grows without bound on a remote backend, and a rollup is a bounded
write:

```ts
export const dayStatSchema = z.object({
  date: z.string(),               // 'YYYY-MM-DD', the writer's local day
  added: z.number().int(),        // gross words added
  removed: z.number().int(),      // gross words removed
  net: z.number().int(),          // added - removed, stored rather than derived
  minutes: z.number().int(),      // active minutes, not wall clock
  byDoc: z.record(z.string(), z.number().int())   // docId → net, for per-document charts
})
```

**Gross added and removed, not just net.** A revision day where 2,000 words are cut and 1,800
written reads as `-200` net, and a tool that shows only net tells a writer who worked hard that
they did nothing. This is the single most important line in the schema.

The local day, not UTC: a writer at 1am is having last night, and a chart that disagrees is a
chart they stop trusting. The offset is stored with the day so a move between time zones does not
retroactively rewrite history.

## Part 2 — Measuring

### `src/renderer/stats/session.ts` (new, pure)

Counting belongs in the renderer, because the renderer is where an edit happens and where the
document already lives. It is pure logic with the clock injected, so it tests as plain data —
the `shared/pm/*.test.ts` standard rather than a live `Editor`.

- A **session** opens on the first edit and closes after an idle timeout (default 5 minutes,
  a setting). "Active minutes" is the sum of sessions, so leaving the app open overnight does not
  award eight hours.
- Word deltas are computed per document from the count before and after each autosave-debounced
  change — reusing the debounce that already exists rather than adding a second timer, and
  reusing `countWords` rather than deriving a second count.
- Suggested-edit marks (Phase 9) count as-if-accepted, matching what `extractText` does there, so
  one definition of "how long is this manuscript" holds across the app.

### `statsService.ts`

Follows `noteService`'s shape — load, debounced flush, snapshot — writing through the
`VfsAdapter`. Deltas are accumulated in memory and flushed on a debounce and on project close, so
a day of writing is a handful of writes, not one per keystroke.

## Part 3 — Goals

Project-scoped, on the manifest beside the other project settings, because a target belongs to
the book:

```ts
goals: z.object({
  target: z.number().int().default(0),          // words, 0 = no target
  deadline: z.string().default(''),             // ISO date
  dailyTarget: z.number().int().default(0),     // 0 = derive from target and deadline
  countScope: z.enum(['manuscript', 'project']).default('manuscript')
})
```

`countScope` matters more than it looks: a thesis's target is the body, not the appendices and
the reading notes, and `flattenManuscript` already knows the difference. Deriving the daily
target from what remains and the days left — rather than a fixed number set once — is what makes
the number honest after a week off.

`FORMAT_VERSIONS.manifest` bumps with a no-op step.

## Part 4 — The Progress panel

A dock panel, listing:

- today against the daily target, and the project against its target;
- a bar chart of the last 90 days (added above the axis, removed below — the gross/net decision
  made visible);
- a per-document breakdown from `byDoc`, and a per-part one via the binder;
- a current streak, defined as consecutive days meeting the daily target, with days before the
  project's first recorded day excluded rather than counted as misses.

**Charts are hand-drawn SVG**, no charting dependency. `MapCanvas.tsx` already draws interactive
SVG in this codebase, the shapes needed here are a bar chart and a sparkline, and a charting
library would be a large dependency in the renderer for two components.

A compact word-count-and-target readout goes in the editor's status area, because that is where a
writer actually looks.

## Part 5 — Export

"Copy stats" and a CSV export of the daily table. A writer who tracks their year in a spreadsheet
should not have to choose between this app and that habit, and CSV is twenty lines of code.

## Deliberately out of scope

Leaderboards, sharing, streak-defending notifications and anything else that turns a writing tool
into a game; cloud sync of statistics; time-of-day heat maps and "productivity scores"; and
per-keystroke telemetry of any kind. Nothing in this phase leaves the machine.

## Verification

- `bash ci/run-checks.sh`.
- Unit: session opening, extending and closing across an injected clock, including an idle gap
  that splits one sitting into two sessions and a burst that does not; gross added/removed on a
  revision that nets negative; local-day boundaries either side of midnight and across a
  time-zone change; streak arithmetic with a gap, with a day below target, and before the first
  recorded day; derived daily target after missed days; `countScope` excluding back matter.
- Unit: the rollup file staying bounded — a simulated year of writing produces 365 rows and no
  event log.
- E2E: type in a document, wait for the debounce, close and reopen the project, and confirm
  today's count persisted and the Progress panel shows it.
- Manual: write for a real session across two documents and confirm the split in `byDoc` matches
  what was typed; disable snapshots and confirm statistics still record, which is the coupling
  this phase exists to avoid.
