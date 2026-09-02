# Accessibility

The honest answer to "does this work with a screen reader" is a list, not a yes. This is that
list, current as of Phase 14 ([`docs/phase-14-plan.md`](./phase-14-plan.md)). It records what is
supported, how it was verified, and what still needs a human with assistive technology to confirm.

## Keyboard

- **Every command is reachable without a mouse.** The command palette is the universal fallback
  for menu items and shortcuts. "Focus Panel…" (and its documented cycle key) reaches a specific
  dock panel the same way; a popped-out window has its own entry point rather than inheriting the
  main window's focus.
- **Focus is never lost or trapped by accident.** Opening a popover (the `@` mention picker, the
  `[` citation picker, a footnote) moves focus into it; Escape closes it and restores focus to
  where it was, including the exact editor selection, in whichever window (main or popped-out)
  the popover was opened in.
- **Modals trap focus while open** and restore it on close — `NewProjectDialog`, `ConnectDialog`,
  `PromptDialog`, and every other dialog built on `useModalFocusTrap`.
- **The editor has no keyboard trap.** Tab inserts or cycles a screenplay style rather than moving
  focus, so it cannot double as the way out — Escape-then-Tab is the documented escape, and it is
  asserted in `e2e/a11y.spec.ts`.

## Semantics and screen readers

- **The dock's tab strip** is a real `tablist`/`tab`/`tabpanel` structure. This comes from
  `dockview-core` itself, confirmed by the axe-core sweep — no code in this app builds it.
- **The file tree** is a `tree`/`treeitem` structure (`src/renderer/panels/explorer/FileTree.tsx`)
  with `aria-expanded` on directories, `aria-selected` on the current row, and `aria-level`
  reflecting depth.
- **Live regions**, each `aria-live="polite"` (nothing in this app is urgent enough to justify
  `assertive`):
  - Save state — announced once per completed save, not on every keystroke's dirty flag.
  - An AI reply arriving — announced once when streaming finishes, not per token.
  - Search result counts — announced once results land for a query.
  - Review/comment activity — announced when a thread or reply lands that this reader did not
    just type themselves.
- **Decorations that carry meaning in colour or style alone gain a text alternative:**
  - Suggested insertions and deletions (Phase 9) each render a visually-hidden label —
    "insertion, by …" / "deletion, by …" — ahead of the text, so a screen reader hears what
    happened rather than reading struck-through prose as ordinary prose.
  - Highlights (Phase 11) get a generic "highlight:" label. The highlight's *category* lives in
    the Research sidecar rather than on the mark itself, so the label cannot yet name the specific
    category — a known gap, not an oversight.
  - Mentions get a "mention:" label ahead of the linked name.
  - Map markers and suggestion authorship still encode identity in colour alone; **not reached
    in this pass.** A second channel (shape, pattern, or an initials label) is still owed here.

## Colour, motion and text size

- **Contrast is checked, not asserted.** `shared/themes.test.ts` computes WCAG contrast ratios
  over every theme's token pairs and fails below AA, for all twenty themes. The test reads
  `renderer/styles.css` and the theme registry together, so a theme cannot be added to one
  without the other, and a palette nobody can read cannot ship.
- **Two high-contrast themes**, dark and light, marked `contrast: 'aaa'` in the theme registry.
  That marker is not a label: the same test holds those two to AAA (7:1) text, 4.5:1 accents and
  a border drawn in the text colour rather than a shade of the surface — so a panel edge at that
  setting is a line, not a hint.
- **200% UI scaling** is covered by an e2e test (`e2e/a11y.spec.ts`) that zooms the real Chromium
  page via `webContents.setZoomFactor(2)` and asserts the file tree and editor stay visible with
  non-trivial size — a smoke test for "does the layout collapse," not a pixel-perfect audit.
- **OS high-contrast mode and `prefers-reduced-motion`**: not covered by this pass — deferred, see
  below.

## Language

- **Per-document language** (`PubDocument.lang`, a BCP-47 tag) drives the editor's `lang`
  attribute, DOCX's `w:lang` on export, and — new in this pass — the OS spellchecker, resolved
  document → project (`manifest.publication.language`) → OS default.
- **The `lang` mark** covers a passage — a quotation, a term — in a different language than the
  surrounding document, and survives a DOCX/EPUB round trip.
- **Right-to-left**: a paragraph's `dir` flows into DOCX's `w:bidi` and `w:jc` `start`/`end`
  mapping, and the toolbar's alignment icons mirror; `left`/`right` in an RTL paragraph mean
  logical start/end, not physical sides.
- **Spellcheck** uses Electron's built-in `session.setSpellCheckerLanguages` — no bundled
  dictionaries, no new dependency. It is set from the app locale at startup and re-set to the
  resolved document language whenever a document is opened or made active.
- **Per-project custom dictionary** lives at `.thepub/dictionary.json`, loaded into the Electron
  session at project open. The native right-click menu on a flagged word offers Chromium's own
  spelling suggestions plus "Add to Dictionary," which writes back into that file so the word
  persists for every collaborator who opens the project, not just this run.
- Grammar checking is explicitly out of scope for this phase — see the plan.

## What is automated, and what is not

**Automated and run on every check of this suite:**

- `shared/themes.test.ts` — WCAG contrast ratios for every theme.
- `e2e/axe.spec.ts` — an axe-core sweep of the shell with every panel opened in turn, failing the
  build on any violation. One violation is disabled and documented in that file: `nested-interactive`
  inside `dockview-core`'s own tab markup, which is that library's DOM, not this codebase's.
- `e2e/a11y.spec.ts` — the keyboard-only flows (Escape-then-Tab, panel focus, modal traps), the
  file tree's tree/treeitem roles, the live regions, and the 200% zoom smoke test.

**Not automated, and not claimed to be:**

- **Manual screen reader verification** — VoiceOver on macOS, NVDA on Windows — through a real
  write-and-export session. This is the plan's own explicit requirement, and this development
  environment has no screen reader and no macOS/Windows host to run one on, so it has not
  happened. Automated checks find missing labels and roles; they do not find a panel that is
  technically labelled and still unusable in practice. Treat everything above as "should work"
  rather than "confirmed to work" until someone verifies it with real assistive technology.
- **OS high-contrast mode and `prefers-reduced-motion` honouring** — not implemented in this pass.
- **Map marker and suggestion-authorship colour-only encoding** — not given a second channel in
  this pass; both are still colour alone.
- **Highlight category labels** — the sr-only label on a highlight says "highlight," not the
  specific category, because the category lives outside the mark's own attributes.

## WCAG certification

Out of scope, per the plan: no formal VPAT is claimed here, and this document is not one.
