# Phase 15 — An assistant that can build things

Phase 10 Track B gave the model tools and a loop, resting on one rule: *the agent never writes to
a document — it proposes, and proposals arrive as Phase 9 suggestion marks.* That rule now has
teeth: Phase 9 shipped, so `insertion`/`deletion` marks, accept/reject, attribution, presence, and
the Word tracked-changes round-trip all exist and all work on anything the agent produces.

This phase spends that. Phase 10's agent can *read* a project and propose prose edits. It cannot
yet make a **record**, fill out a **cast**, or bring **research** back with its sources attached —
the three things a writer actually asks an assistant for once it stops being a novelty.

The whole phase is one extension of the existing rule:

> **The agent proposes; a person commits.** For prose that means a suggestion mark. For records
> and sources it means a *draft* — a real record, marked `provisional`, that a person accepts,
> edits or discards. There is no path by which a model's output becomes project truth without a
> human action.

That is the same shape twice, and building it twice differently would be the mistake.

---

## Why

Three requests recur, and none is served by "ask the chat panel and paste the answer back":

1. **Research.** "What did a Lisbon dockworker earn in 1954?" The answer is useless if the writer
   cannot see where it came from, and dangerous if the model invented it. The app already has a
   CSL-JSON source library (Phase 5) and, after Phase 11, attachments — so a researched claim has
   somewhere real to land, with a citation, rather than being a paragraph in a chat log.
2. **Character scaffolding.** A novelist with a cast of thirty does not want thirty blank record
   forms. They want twelve plausible drafts they can then argue with. The work is not the prose,
   it is the *starting from nothing*.
3. **Ensemble randomisation.** "Give me a ship's crew of eight, mixed nationalities, one of whom
   is lying about why they signed on." A group with internal structure — not eight independent
   rolls, which is what a naive implementation produces and why they always read like a list.

Each is a place where a model is genuinely good and where the app already owns the destination
format. That combination is the whole reason to build it here rather than leave it to a chat
window.

---

## The one new concept: a provisional record

`storyEntitySchema` gains one field:

```ts
/**
 * Written by the assistant and not yet accepted by a person.
 *
 * The record is real — it has an id, it is in the file, mentions can resolve to
 * it — but it is visibly the model's guess. Accepting clears the flag; that is
 * the only thing accepting does.
 */
provisional: z.boolean().default(false)
```

One boolean, and `FORMAT_VERSIONS.entities` bumps with a no-op migration step. Not a separate
"drafts" file, and this is the load-bearing decision: a draft cast that lives outside the record
store cannot be searched, cannot be mentioned, cannot be reordered, cannot be linked to a beat —
so the writer cannot *work* with it, which is the only way to find out whether it is any good. A
draft in a sidecar file is a preview; a provisional record is a draft.

The cost is that every consumer must decide what to do with `provisional`. That is a feature: the
list is short and each answer is obvious.

| Surface | Behaviour |
|---|---|
| Records panel | Shown, tinted, with Accept / Discard on the card |
| Mention scanner | Resolves normally — a draft character mentioned in the draft is the point |
| Search index | Indexed normally |
| Manuscript export | Records are not exported; nothing to decide |
| Storyboard cast | Selectable, marked |
| `randomize` / `scaffold` reruns | May overwrite a provisional record; never an accepted one |

That last row is the safety property, and it is worth stating as an invariant rather than a rule:
**a tool in this phase may only modify a record it created and that nobody has accepted.** Not "it
should not" — the service refuses, the same way `ReviewService.patchThread` refuses another
author's thread.

Sources get the same treatment, reusing the same word: a researched source is written to the
library `provisional`, with its `note` carrying what the model claimed and its `URL`/`accessed`
carrying where it says it got it.

---

## Part 1 — Writing tools

Phase 10's `tools.ts` is read-mostly by design. This adds the first writing tools, and each one
returns a *proposal*, never a fact.

| Tool | Does | Commits? |
|---|---|---|
| `draft_record` | Create one provisional record of a kind, from a description | Provisional only |
| `draft_ensemble` | Create N provisional records with a stated group relationship | Provisional only |
| `revise_record` | Propose field changes to an existing record | Only if provisional |
| `add_source` | Add a provisional CSL-JSON source with a URL and an access date | Provisional only |
| `propose_edit` | Existing Phase 10 behaviour: prose as suggestion marks | Suggestion marks |

`revise_record` is the one that needs the refusal path tested, because it is the only tool that
can be pointed at an accepted record — and a model that "helpfully tidies" a character the writer
spent an afternoon on is the failure this whole design exists to prevent.

### Gating

Unchanged from Phase 8 and 10, and re-stated because it keeps getting harder to remember as the
surface grows: nothing here exists when AI is off, no tool runs without `settings.agent`, and no
tool that writes anything runs without the writer having started *this* action. There is no
background scaffolding, no "we noticed you have no antagonist yet".

---

## Part 2 — Ensembles that are not eight independent rolls

`draft_ensemble` takes a group description, a count, and a set of **constraints**, and this is
the part that has to be designed rather than prompted:

```ts
interface EnsembleRequest {
  kind: EntityKind
  count: number
  premise: string
  /** Properties the group must satisfy as a group, not individually. */
  constraints: {
    /** e.g. "no two share a home town" */
    distinct?: string[]
    /** e.g. "exactly one is lying about why they signed on" */
    exactlyOne?: string[]
    /** e.g. "at least two have served together before" */
    atLeast?: { count: number; property: string }[]
  }
}
```

The constraints go into a single request that produces the whole group at once, rather than N
requests producing N people. A per-character loop cannot satisfy "exactly one of them is lying"
except by accident, and the characteristic failure of ensemble generators — everyone being the
same person with different hair — is exactly what a whole-group request avoids.

Validation is ours, not the model's: the returned group is checked against the constraints it was
given, and a group that fails is retried once with the failures named. Two failures and the tool
returns what it got with the unmet constraints listed in the tool result, which the writer sees.
A generator that silently ships a group violating the constraint the writer typed is worse than
one that admits it.

---

## Part 3 — Research that carries its sources

`add_source` is the only tool in this phase that can involve information from outside the
project, and it is the one that needs the most conservative design.

- **The model does not browse.** This phase adds no fetching. `add_source` records a *claim* and
  the citation the model attributes it to; verifying it is the writer's, and the UI says so
  plainly on the card ("Attributed by the assistant — not verified").
- Fetching, if it is ever built, belongs in Phase 11's research library where captures, offline
  copies and attachment storage already live — not bolted onto a chat tool.
- A source with no `URL` and no identifiable work is refused by the tool rather than stored, since
  an uncheckable citation in a bibliography is worse than a note in a chat.

This is deliberately less than a writer might hope for, and the reason is that the failure mode of
a confident fabricated citation in an academic bibliography is career damage. The app's Phase 6
promise is that it serves theses, and a feature that would be merely embarrassing in a novel is
not acceptable there.

---

## Part 4 — Where this appears

- **Records panel**: a "Draft with the assistant…" action per record kind, and an "Ensemble…"
  dialog taking the count, the premise and the constraints. Provisional cards are tinted with
  Accept / Discard.
- **AI panel**: nothing new. The tools show in the existing tool-call trace that Phase 10 built,
  because that trace is the audit surface and a second one would split it.
- **No new panel.** Everything lands in the panel that already owns the thing being made.

---

## Deliberately out of scope

- **Writing prose into a document directly.** It goes through suggestion marks or it does not
  happen.
- **Accepting anything automatically**, including on a "the model was very confident" heuristic.
- **Web browsing and retrieval-augmented research** — Phase 11.
- **Editing the manifest, styles, layouts or connections.** The agent works on story content.
  Nothing it does should be able to change where files live or how they are saved.
- **Multi-step autonomous planning.** The Phase 10 loop's step cap stays. A run that needs forty
  steps is a run nobody is reading.

---

## Verification

- Unit: constraint validation over hand-written ensembles, including a group that fails
  `exactlyOne` and one that fails `distinct`; the `revise_record` refusal on an accepted record;
  the `add_source` refusal with no identifiable work.
- Unit: the provisional flag surviving a save/load round trip, and the migration step existing.
- E2E: draft an ensemble against a stub provider, accept one record and discard another, close and
  reopen the project, and assert the accepted one is there without its flag and the discarded one
  is gone — the persistence proof this repo requires of any renderer feature.
- E2E: with AI off, none of it is reachable.
