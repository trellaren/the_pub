# Plan: From "AI connection" to a writing agent

## Context

Quoth already ships a tool-using agent (roadmap Phases 8, 10b and 15 are marked shipped, and the
code agrees): `src/main/ai/agentRunner.ts` loops over `src/main/ai/tools.ts`'s eleven tools
(search, semantic retrieval, read documents/records, `propose_edit`, draft records/ensembles,
`add_source`). It is hidden behind an opt-in checkbox (`aiSettings.agent`, default false) and the
panel is still a chat window with five preset buttons.

The user wants it to become the project's assistant proper: on by default once AI is on, and able
to do peer review, spelling/grammar/style passes, research with (writer-controlled) web access, and
prompt generation / writing help.

Gaps found while exploring, which this plan closes first because everything else builds on them:

- **Proposals bypass track changes.** The roadmap's load-bearing rule is "the agent proposes, it
  never writes", via Phase 9 suggestion marks. Phase 9 shipped, but `applyProposal` in
  `src/renderer/panels/ai/AiPanel.tsx:500` still does a direct `insertContentAt` on the *active*
  editor, ignores `proposal.docPath`, and writes no `insertion`/`deletion` marks. README says
  otherwise.
- **Tool history is forgotten between turns.** `ai:send` (`src/main/ipc/registerHandlers.ts:1463`)
  replays only `role` + `text`; prior `toolCalls` never reach the model again.
- **No programmatic spellcheck.** Only Chromium's squiggles (`createEditor.ts` `spellcheck:'true'`).
- **No web access.** `src/main/research/capture.ts` (`capturePage`) and `src/main/sources/lookup.ts`
  (DOI/ISBN) exist and are reusable; there is no search.
- **No review-comment tool**, although `ReviewService.createThread` and `applyAnchorMark` exist.

## Decisions (confirmed with the user)

1. **Agent by default.** Tools are always offered once `app.ai.enabled` is on. The `agent` opt-in
   is removed (chats migration). The panel becomes an assistant with task launchers.
2. **Priority order:** (a) peer review as anchored comments + tracked suggestions; (b)
   spelling/grammar/style pass as suggestion marks; (c) research with web access; (d) prompt
   generation and writing help.
3. **Web access is a writer (app-scoped) setting** with three levels: `none` / `urls` (fetch only
   URLs the writer gave) / `search` (web search + fetch). A citation is stored as a *captured*
   source only after a successful fetch whose text is attached to the research library; anything
   else stays the Phase 15 "attributed, unverified" kind.
4. **Write policy is a writer (app-scoped) setting:** `suggest` (default), `direct-trivial`
   (spelling/punctuation fixes apply immediately, everything else is a suggestion) or `direct`.
   Any direct write leaves **immutable provenance inside the document**: an inline `aiAuthored`
   mark on the text plus an append-only `provenance` log in the document envelope. The writer may
   delete the text; the log entry stays, and `DocumentService.write` refuses to drop entries.

Alternatives considered and rejected: a separate "AI drafts" sidecar (contradicts Phase 15's
"a draft in a sidecar is a preview"); a bespoke diff/apply UI in the panel (rebuilds accept/reject
worse than Phase 9's marks); an in-process spellchecker (Hunspell/LanguageTool) — model-driven
proofreading reuses the provider layer and lands as suggestions, which the roadmap already asks for.

## Cross-cutting conventions

- **Doc-edit routing** (built in Phase 1, reused by every writing tool): a tool never writes prose
  itself. It emits an `edit` stream event. The renderer applies it in the open editor when the
  document is open (so autosave and undo behave normally); otherwise it calls `ai:applyEdit` and
  main edits the JSON and writes through `DocumentService.write` with reindex + reconcile, the
  way `HistoryService.restoreInPlace` already does (`src/main/services/historyService.ts:46-85`).
- **One text walker.** All locating goes through `findTextOccurrences` / `normalizeBlockText`
  (`src/shared/pm/anchors.ts:134`, `src/shared/pm/extractText.ts:184`); all splicing follows the
  `applyAnchorMark` pattern (`anchors.ts:167`). No new walker.
- **Assistant author identity.** `assistant-<ownerAuthorId>` (per owner, so review files under
  `reviews/<doc>/<authorId>.json` stay single-writer when two collaborators both use assistants).
  Hyphen, not colon, for Windows filenames.
- **Gating.** Nothing here exists when `app.ai.enabled` is off (`DockRoot.tsx`, `panelRegistry.tsx`,
  `ai:send` guard). Web and write-policy settings are app-scoped like `aiEnabled`, never project
  settings, so a shared folder cannot switch them on for a collaborator.
- **Credentials.** Search API keys live only in `AiKeyStore` (safeStorage); `ai:keyStatus`
  returns booleans.
- **Format bumps.** `FORMAT_VERSIONS.chats` 4→5 (Phase 1), `FORMAT_VERSIONS.document` 9→10
  (Phase 4). Each with a `MIGRATIONS` step and a comment explaining why. After touching any model
  file, grep for the deprecated bare `FORMAT_VERSION` import.
- **First task on execution:** write the design spec to
  `docs/superpowers/specs/2026-10-02-writing-agent-design.md` (this plan's Context, Decisions and
  Conventions sections) and commit it, per the brainstorming workflow; plan mode prevented writing it now.

