# Phase 6 — Beyond fiction

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 6 — the phase where Quoth actually
serves a thesis, an essay or a screenplay rather than merely being capable of it. Depends on
Phase 4 (templates) for the delivery mechanism and Phase 5 (citations) for the academic templates
to have something to cite with.

## Why most of this is configuration

Once a template is a serialised project, "support a thesis" mostly means *authoring a template*:
a style pack, a citation style, a starting layout. Four things genuinely need code, and they are
listed below in ascending order of how much: numbered headings (a style attribute plus a
renderer), panel vocabulary (unhardcoding a two-value enum), front/back matter (a warning that
already exists, surfaced), and screenplay (a style pack, one keyboard shortcut, and a file
format).

## Part 1 — Numbered headings

The gap an academic notices first. `namedStyleSchema` (`src/shared/model/style.ts`) already
carries `headingLevel` and `outlineLevel`; what it cannot express is "1.2.3".

### `src/shared/model/style.ts`

```ts
numbering: z.object({
  format: z.enum(['decimal', 'upper-roman', 'lower-roman', 'upper-alpha', 'lower-alpha']),
  startAt: z.number().int().min(0).default(1),
  /** e.g. "%1.%2.%3 " — %n is the counter at outline level n. */
  levelText: z.string()
}).optional()
```

`levelText` is Word's own `w:lvlText` syntax, deliberately, because that is what the DOCX export
has to emit anyway — inventing a friendlier syntax means writing a translator to this one.

### `src/shared/pm/headingNumbers.ts` (new)

A pure function, and the single source of truth for what number a heading has:

```ts
computeHeadingNumbers(doc: PmDoc, styles: NamedStyle[]): Map<number, string>   // blockIndex → "1.2.3"
```

It walks top-level blocks in document order, resolves each one's outline level exactly as
`buildToc` in `src/shared/pm/toc.ts` already does (`outlineLevel ?? headingLevel`), and maintains
a counter stack, resetting deeper levels when a shallower one increments. Numbers are **computed,
never stored** — the same decision Phase 3 made for footnote numbering, and for the same reason:
a stored number is wrong the instant a heading is inserted above it.

Three consumers, all of which must use this one function rather than re-deriving:

- **Screen**: a ProseMirror decoration in a new `extensions/headingNumbers.ts`, rendering the
  number as a widget before the heading text. A decoration, not content, so the number is never
  selectable, never in the undo history, and never in `extractPlainText`.
- **`buildToc`**: `TocEntry` gains `number?: string`, so contents entries read "1.2 Method".
  Phase 3's `field` rendering of a `ref` picks this up for free.
- **DOCX export** (`src/main/docx/toDocx.ts`): emits real Word numbering via `numbering.xml`, so
  Word owns the numbers in the exported file rather than receiving them as literal text. The
  `docx` library supports this directly; `src/main/docx/fixtures.ts` already has `WORD_NUMBERING`
  as an import-side fixture to model the shape against.

## Part 2 — Panel vocabulary

`src/shared/model/entity.ts` hardcodes `entityKinds = ['character', 'location'] as const`, with
`SUGGESTED_FIELDS: Record<EntityKind, string[]>` keyed off it. A thesis wants interviewees and
concepts; a research paper wants sources and hypotheses.

The move is to keep `EntityKind` a `string` at the type level and put the *list* on the project:

### `src/shared/model/entity.ts`

`entityKindSchema` becomes `z.string()` — the kinds a given project offers are project data, not a
compile-time enum. `entityKinds` stays exported as the fiction default (`['character',
'location']`) and `SUGGESTED_FIELDS` becomes `Record<string, string[]>` with the two existing
entries as the fiction defaults, looked up leniently (an unknown kind suggests no fields rather
than throwing).

### `src/shared/model/manifest.ts`

```ts
entityKinds: z.array(entityKindDefSchema).optional()   // { id, label, labelPlural, suggestedFields? }
```

Absent means "the fiction defaults", so every existing project is unaffected and no migration
needs to invent data. Bump `FORMAT_VERSIONS.manifest` with a no-op step regardless — the house
rule in `CLAUDE.md` is a bump per shape change, not a bump per lossy change. (If Phase 4 already
bumped it to 2 for `projectType`, this is 2 → 3.)

### Renderer

`panelRegistry.ts` currently maps a `PanelComponent` union that includes `'characters'` and
`'locations'` as distinct members. Collapse them into one `'records'` panel parameterised by kind,
so a project with five kinds doesn't need five registry entries. The `panel.characters` /
`panel.locations` commands become generated per configured kind, registered the same way
`DockRoot.tsx` registers panel commands today. Existing saved layouts referencing
`'characters'` must still resolve — map the two legacy component ids onto the parameterised panel
at layout-load time rather than migrating `layouts.json`, since a layout can also live in a
popped-out window's state.

**`projectType` selects the default kind list** by way of the template, not by a switch statement
anywhere in the renderer — the thesis template simply ships an `entityKinds` array in its
`project.json`. That is the Phase 4 payoff being spent.

## Part 3 — Front and back matter

`partRoleSchema` in `src/shared/model/manuscript.ts` is already `['front', 'body', 'back']`, and
`misplacedFrontMatter(nodes)` already computes which front-matter parts sit after body content. It
is a warning nobody currently sees, and role today only affects whether a part contributes a
title-page heading in `toExportItems`.

This phase surfaces and completes it, and it is deliberately small:

- Show `misplacedFrontMatter`'s result in the manuscript panel as an inline warning with a "move
  to front" action. It stays a **warning, not an enforcement** — auto-reordering someone's drag is
  a worse failure than letting them see a problem and fix it.
- Give `front` and `back` parts their own export treatment in `toExportItems`: front matter before
  the body with no chapter numbering, back matter after. This is the part a thesis actually needs
  — a title page, abstract and acknowledgements that don't count as Chapter 1.

## Part 4 — Screenplay

The one case needing real code, and less than expected. Screenplay elements — Scene Heading,
Action, Character, Parenthetical, Dialogue, Transition — map onto named styles almost exactly,
because `NamedStyles.addKeyboardShortcuts().Enter` in
`src/renderer/panels/editor/extensions/namedStyles.ts` already implements Word's "style for the
following paragraph" via `nextStyle`, and that *is* how screenplay editors behave: Enter after a
Character line gives you Dialogue.

- **A style pack.** Six built-in-shaped styles in Courier 12pt with the standard indents, shipped
  as a screenplay template (Phase 4), not added to `BUILTIN_STYLES` — a novel project should not
  grow six screenplay styles it will never use.
- **Tab cycles element.** A `Tab` shortcut alongside the existing `Enter` handler, walking a cycle
  order rather than `nextStyle`'s chain — the two are genuinely different relationships (what
  comes *next* vs. what this line could *instead* be), so this is a new optional field on
  `namedStyleSchema`, `cycleStyle?: string`, forming a ring. Reuse `setNamedStyle(styleId)`
  unchanged for the actual application. Guard against a malformed ring (a `cycleStyle` chain that
  never returns to its start) by bounding the walk at the style count.
- **Scene-heading autocomplete** fed by the location records: a third `@tiptap/suggestion`
  instance following `mention.ts`, triggered when the caret is in a Scene Heading style rather
  than by a trigger character.
- **`.fountain` import/export** in `src/main/fountain/`, mirroring `src/main/docx/`'s structure and
  its asymmetry rule: export through a serialiser of our own, but import parsed against fixtures
  written the way Final Draft and Highland actually emit Fountain, not round-tripped through our
  own exporter — which would only prove the importer agrees with itself.

## Part 5 — The templates

With the above in place, the templates are authoring work rather than code:

| Template | Styles | Citation style | Entity kinds | Notable |
|---|---|---|---|---|
| Thesis | Numbered headings, front matter | Chicago notes-bib | interviewee, concept, source | Front/back matter parts pre-created |
| Essay | Numbered off, tighter spacing | MLA | concept, source | Single-document layout |
| Research paper | Numbered headings | APA | hypothesis, dataset, source | Author-date, inline citations |
| Screenplay | Courier pack, `cycleStyle` ring | — | character, location | Fountain export offered |

## Verification

- `bash ci/run-checks.sh`.
- New unit tests: `computeHeadingNumbers` across level skips (an `<h3>` directly under an `<h1>`),
  a `startAt` other than 1, and counters resetting correctly on a shallower heading; Fountain
  import against third-party fixtures; `cycleStyle` ring termination on a malformed ring.
- New e2e tests: numbered headings render on screen and survive a project close/reopen (the
  repo's rule for renderer state that persists — a decoration recomputed from styles is exactly
  the kind of thing that has broken here before); a project configured with custom entity kinds
  opens the right record panels, and a legacy layout referencing `'characters'` still resolves.
- Manual: export a numbered-heading document to `.docx`, open in Word, insert a heading in the
  middle, and confirm **Word** renumbers — proving the export emitted real numbering rather than
  baked-in text.
