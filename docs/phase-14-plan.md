# Phase 14 — Accessibility and language

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 14. Independent of every other phase, and
the only one on this roadmap that decides whether some writers can use the app at all rather than
how well it serves them.

## Why this is a phase and not a pass

Accessibility done as a sweep regresses on the next feature. The deliverable here is therefore
half fixes and half **things that keep the fixes true**: an axe-core check wired into the e2e
suite, and keyboard-only paths asserted in tests that already drive the real app.

The honest starting position: ProseMirror's `contenteditable` and semantic headings mean the
editor is partly accessible by accident. The dock, the popovers and the panels are not — and
`dockview` tabs, the mention/citation `Suggestion` popups and the modal dialogs are all custom
DOM built for the mouse.

## Part 1 — Keyboard

- **Every command reachable without a mouse.** Phase 1 made menu items, shortcuts and the command
  palette one code path, so the palette is already the universal fallback; what is missing is
  reaching *panels*. A "Focus panel…" command plus a documented cycle key make the dock
  navigable, and popped-out windows need their own entry point rather than inheriting the main
  window's focus.
- **Focus is never lost or trapped by accident.** Opening a popover moves focus into it; Escape
  closes it and returns focus to where it was, including inside the editor at the same selection.
  `mention.ts`'s `renderPopup()` already builds DOM off `props.editor.view.dom.ownerDocument` so
  it works in a popped-out window; focus restoration has to be equally careful about *which*
  document it is restoring into.
- **Modals trap focus while open** (`NewProjectDialog`, `ConnectDialog`, `PromptDialog`), and
  return it on close.
- **No keyboard trap in the editor.** Tab inserts or cycles a style (Phase 6's screenplay
  behaviour), which means Tab cannot also be the way out. Escape-then-Tab is the documented
  escape, and it is asserted in a test because this is the single most common editor a11y bug.

## Part 2 — Semantics and screen readers

- **Roles and names for the shell**: the dock's tab strip as a real tablist with tabs and panels,
  each panel with an accessible name; the file tree as a `tree`/`treeitem` structure with
  expanded state, which is what makes it navigable at all; toolbars as toolbars with pressed
  state on toggles.
- **The editor's accessible name** is the document title, and its `aria-multiline` and role are
  explicit rather than inferred.
- **Live regions for what changes without being touched**: save state, an arriving AI reply
  (Phase 8's stream, announced politely and not per token), search result counts, and a
  collaborator's comment landing (Phase 9). Each `aria-live="polite"`; nothing in this app
  justifies `assertive`.
- **Decorations that carry meaning need text.** Mention marks, suggestion insertions and
  deletions (Phase 9), and highlights (Phase 11) are colour plus underline today; each gains a
  screen-reader-only label so a deletion is heard as a deletion rather than as ordinary prose.
- **Icons that are the only label get one.** The map icon glyphs, the toolbar's format buttons,
  and every icon-only button in the panels.

## Part 3 — Colour, motion and text size

- **Contrast is checked, not asserted.** There are twelve themes in `appStateSchema`, which is
  twelve chances to ship an unreadable one. A unit test computes WCAG contrast ratios over each
  theme's token pairs in `shared/themes.ts` and fails below AA — the same "make the rule the
  suite enforces" move `toDocx.test.ts`'s closed-world test makes.
- **A high-contrast theme** as a thirteenth, plus honouring the OS's own high-contrast and
  `prefers-reduced-motion` settings (Electron exposes both) — panel and popover transitions are
  the animations that matter here.
- **Never colour alone.** Suggestion authorship, highlight categories and map markers all encode
  meaning in colour today; each gets a second channel — a pattern, a shape or a label.
- **UI scaling** that does not break the dock layout, tested at 200%.

## Part 4 — Language

### Per-document language

`lang` on the document envelope (not in the ProseMirror content, following Phase 7's reasoning
for `sections`: envelope-level state must not be seen as body text by find/replace, word count,
the diff or the mention scanner). It drives the editor's `lang` attribute, the spellchecker, and
`w:lang` on DOCX export — where its absence today is a real defect, because Word will
spell-check a French chapter against English otherwise.

A **`lang` mark** for a passage in another language: a quotation, a term, a whole cited paragraph.
Marks over nodes again, and it exports as a run property. This is a new mark type, so it takes
the full closed-world route: the TipTap extension, `EDITOR_MARK_TYPES` in `toDocx.ts`,
`fromDocx.ts` import, and a `FORMAT_VERSIONS.document` bump with a no-op migration step.

Project default language comes from the manifest's `publication.language` (Phase 12) when that
exists, so a book states its language once.

### Right-to-left

`dir` on a paragraph, added to the existing `paragraphFormat` extension rather than as a new
node. The bidi text itself is the browser's job and mostly free; what is not free is that
**alignment becomes start/end rather than left/right**. `left` in an RTL paragraph must mean the
logical start, or a Hebrew manuscript exports with every paragraph on the wrong side. The DOCX
mapping (`w:bidi`, `w:jc` with `start`/`end`) moves with it, and the toolbar's alignment icons
mirror.

### Spellcheck

Electron's built-in spellchecker via `session.setSpellCheckerLanguages`, driven from the
document's language — no bundled dictionaries, no new dependency, and the OS's own custom words
on macOS. A per-project custom dictionary (character names are the obvious case) lives in
`.thepub/dictionary.json` and is added to the session at project open.

Grammar is **not** in this phase. If a writer has Phase 8's embedded model, "check this
paragraph" is already a preset; a real grammar engine is a product of its own.

## Part 5 — Keeping it true

- **axe-core in the e2e suite**, run against the shell with each panel open, failing the build on
  a violation. This is the part that stops the phase from decaying.
- **Keyboard-only e2e paths** for the flows that matter: create a project, create a document,
  type, apply a style, insert a mention, open and dismiss a popover, export.
- A short `docs/accessibility.md` recording what is supported and what is not, because the honest
  answer to "does this work with a screen reader" is a list, not a yes.

## Deliberately out of scope

WCAG certification or a formal VPAT; braille display work beyond what the OS provides; voice
control and dictation (the OS supplies both, and the editor's job is to not fight them); machine
translation; localising the app's own interface into other languages — which is a real and
separate phase, distinct from *writing* in another language, and one this codebase would need a
string-extraction pass to even begin.

## Verification

- `bash ci/run-checks.sh`.
- Unit: contrast ratios for all themes; alignment mapping under RTL in both export directions;
  the `lang` mark surviving a DOCX round-trip; spellchecker language resolution from document,
  then project, then OS default.
- E2E: axe-core clean across the shell with each panel open; the keyboard-only flows above,
  including Escape returning focus to the exact editor selection it left; Tab in the editor not
  trapping focus; the app at 200% scale with the dock still usable.
- Manual — and this phase is not done without it: VoiceOver on macOS and NVDA on Windows through
  a full write-and-export session. Automated checks find missing labels; they do not find a panel
  that is technically labelled and impossible to use.
