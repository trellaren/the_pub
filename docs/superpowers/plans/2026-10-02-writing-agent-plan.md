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

---

## Phase 1 — Agent by default, assistant identity, suggestion-mark proposals, tool replay

Goal: remove the opt-in; give the assistant an author id; make `propose_edit` land as Phase 9
suggestion marks in the right document; replay tool calls across turns.

**1a. Assistant identity** — `src/shared/model/author.ts`: add `ASSISTANT_ID_PREFIX`,
`assistantProfile(owner)` (`{ id: 'assistant-'+owner.id, name: 'Assistant', color }`),
`isAssistantAuthor(id)`; `describeAuthor` names the prefix "Assistant" when unregistered.
`appState.assistant()` beside `appState.author()`; `ProjectSession` hooks expose it. On first
assistant write, register it in `authors.json` so collaborators and DOCX export render the name.
`ReviewService` (`src/main/services/reviewService.ts`): `createThread`/`reply`/`mine`/`flush` take
an optional `as?: AuthorProfile` (default `this.me()`), and `createThread` accepts an optional body
`text` (same paragraph shape `reply()` builds). Phase 2 needs this.

**1b. Drop the toggle** — `src/shared/model/ai.ts`: remove `agent` from `aiSettingsSchema` and
`aiSettingsOverrideSchema`; add `content: z.string().default('')` to `toolCallSchema` (model-facing
result, clipped ~4 000 chars; `result` stays the one-line summary). `constants.ts` `chats: 5`;
`migrate.ts` step 4→5 deletes `settings.agent` and each `chats[].settings.agent` (first
value-changing chats step; comment why). `registerHandlers.ts` `ai:send` always calls `runAgent`;
`session.ai.run` remains for `ai:dailyPrompt`. Remove the checkbox (`AiPanel.tsx` ~L408) and the
`settings.agent` gate on `RetrievalManager`. Add a system preamble line telling weak local models
that answering without tools is fine. e2e: `e2e/ai-agent.spec.ts` `useAgent()` drops `agent: true`;
check `ai.spec.ts`/`retrieval.spec.ts` for assertions that request bodies carry no `tools`.

**1c. Tool replay** — new pure `src/main/ai/history.ts` `historyToOutbound(messages)`: an assistant
message with `toolCalls` becomes `{role:'assistant', text, toolCalls:[{id,name,args}]}` followed by
`{role:'user', text:'', toolResults:[{id, content: call.content || call.result}]}`. Use it in
`ai:send` instead of the role+text map. Unit-test both dialects in `providers.test.ts` with a
replayed history (adjacent user turns, `normalizeMessages`). `agentRunner.ts` records `content`.

**1d. Proposals become suggestion marks, routed by `docPath`** — new pure
`src/shared/pm/assistantEdits.ts`:

```ts
export const assistantEditSchema = z.object({
  id, runId, docId, docPath, authorId, model, at: z.string(),
  mode: z.enum(['suggest', 'direct']),          // 'direct' unused until Phase 4
  ops: z.array(z.discriminatedUnion('kind', [
    { kind: 'replace', blockIndex, start, end, text, reason },   // normalised offsets
    { kind: 'append', text, reason },
    { kind: 'anchor', blockIndex, start, end, anchorId }
  ]))
})
export function applyAssistantEdit(doc: PmDoc, edit): { doc: PmDoc; failed: number[] }
```

`replace` in `suggest` mode = `deletion {authorId, at}` over `[start,end)` plus a new text node
after it carrying the covered node's formatting marks + `insertion {authorId, at}`; `start===end`
is a pure insertion; `append` = new paragraph with `insertion`; `anchor` delegates to
`applyAnchorMark`. Ops within a block apply in descending `start` order.

- `ai.ts`: replace `editProposalSchema` and the `proposal` stream event with
  `{ type: 'edit', requestId, edit }`. Delete `EditProposal`.
- `tools.ts`: rename `propose_edit` → `suggest_edit` (args `path, find, replace, reason`). Locate
  with `findTextOccurrences`; 0 hits → "quote it exactly, within one paragraph"; >1 → "ambiguous,
  include more surrounding words"; empty `find` → `append`. `ToolContext` gains `assistant`,
  `runId`, `model`, `onEdit` (replaces `onProposal`).
- New IPC `ai:applyEdit` `{ edit } → { ok, failed[] } | { ok:false, reason:'conflict'|'missing'|'no-match' }`
  in `contract.ts` + `channels.ts`. Handler: read → `applyAssistantEdit` → `documents.write(path,
  doc, mtime)` → the same tail as `doc:write` (`registerHandlers.ts:482-497`: `indexDocument`,
  notes/reviews/highlights reconcile, change events). Extract that tail into
  `commitDocumentWrite(...)` and call it from both. Retry once on `conflict`.
- Renderer: `chatStore.ts` `listenForReplies` `edit` branch → new
  `src/renderer/panels/ai/applyEdit.ts` `applyAssistantEditLocally(edit)`: `getEditor(edit.docId)`
  present → apply to `editor.getJSON()` and replace content with a transaction carrying
  `suggestionModeKey` meta so a writer already in suggesting mode doesn't get double marks (add
  `replaceDocument(editor, doc)` to `editorActions.ts` beside `resolveSuggestion`, which has the
  same latent issue, and reuse it there); else `invoke('ai:applyEdit')`. Outcome lands in the run
  trail ("Suggested an edit in <title> · open").
- Delete `EditProposalCard`, `applyProposal`, `proposals`, `dismissProposal`. Route the footer
  "Insert into document" (`insertIntoDocument`) through the same path so no button writes
  assistant prose without marks.

**Tests.** Unit: `assistantEdits.test.ts` (replace inside a bold run, hard-break block, ambiguous
find, append; `listSuggestions` sees the assistant id), `history.test.ts`, `migrate.test.ts` chats
4→5, `tools.test.ts` (`suggest_edit` emits an edit and never writes). E2E `ai-agent.spec.ts`: stub
turn calls `suggest_edit` on the open doc → `ins`/`del` with `data-author^="assistant-"` appear,
Review panel lists them, accept resolves; doc closed → file on disk gains marks and search finds
the inserted text; second turn's request body contains the prior tool calls.

**Risks.** Content replacement resets the selection (precedent: `resolveSuggestion`); map and
restore the cursor if cheap. Weak local models now always see tool specs.

---

## Phase 2 — Peer review as anchored comments

Tools in `tools.ts`, all wrapping `session.reviews`:

- `comment` `{ path, quote, text }`: locate `quote` (unique, within one paragraph), mint
  `anchorId`, `reviews.createThread(docId, anchorId, quote, blockIndex, { as: assistant, text })`
  **first**, then emit an `anchor` edit via doc-edit routing. If the mark never lands, the next
  reconcile marks the thread orphaned with `anchorText` intact — existing recovery.
- `list_comments` `{ path, status: open|resolved|all }` → `reviews.list(docId)` rendered as
  `threadId · author · status · "anchorText" · body · replies`.
- `reply_comment` `{ path, threadId, text }` → `reviews.reply(..., { as: assistant })`.
- `REVIEW_WRITING_TOOLS = ['comment','reply_comment']`; `ai:send` sends `review:changed {docId}`
  when one runs (mirrors `RECORD_WRITING_TOOLS`).
- Task chips: "Review this document" (comments via `comment`, line edits via `suggest_edit`, short
  overall note) and "Address reviewer comments" (`list_comments` → `suggest_edit`/`reply_comment`).
- Review panel needs no change beyond 1a (`describeAuthor` supplies name/colour).

Tests: `reviewService.test.ts` (thread written to `reviews/<doc>/assistant-<owner>.json`, owner file
untouched); `tools.test.ts` ambiguous quote refused. E2E: stub calls `comment` → thread with author
"Assistant", anchor span present, resolve works; `docx.spec.ts` asserts the assistant comment exports
with its author name.

---

## Phase 3 — Spelling, grammar and style pass as suggestion marks

- `ToolContext` gains `complete(system, user, maxTokens): Promise<string>` — a non-tool
  `streamCompletion` bound to the run's settings/key/abort signal, built in `runAgent`. Capped by
  `MAX_PROOFREAD_CALLS = 12` per tool call, separate from `MAX_STEPS`.
- New `src/main/ai/proofread.ts` (pure where possible): `chunkBlocks(blocks, maxChars=6000)` over
  `extractBlocks(doc.content)` (whole blocks only); `proofreadPrompt(chunk, kinds, lang)` numbers
  blocks and asks for strict JSON `[{block, find, replace, reason, kind}]`,
  `kind ∈ spelling|grammar|punctuation|style`; `parseFindings` validates with zod and keeps only
  findings whose `find` occurs exactly once in that block's normalised text; returns `replace` ops.
- Tool `proofread` `{ path, kinds (default spelling,grammar,punctuation), fromBlock, toBlock? }`.
  Over-long documents return the covered range and ask the model to continue with `fromBlock`.
  Emits **one** edit per document (one content replacement / one disk write). Language from
  `doc.lang`, falling back to the manifest. Summary like "Proofread Chapter 3 — 14 suggestions".
- Chip "Proofread this document" (needs an active document).

Tests: `proofread.test.ts` (chunk boundaries, hallucinated `find` rejected, duplicate occurrence
dropped, op ordering); E2E: stub scripts the nested JSON reply → `del`/`ins` pair for the misspelt
word. Out of scope: live underlines, LanguageTool/Hunspell, dedupe with Chromium squiggles.

---

## Phase 4 — Write policy and immutable provenance

- Setting `app.ai.writePolicy: 'suggest'|'direct-trivial'|'direct'` (default `suggest`), app-scoped:
  `appStateSchema` in `src/shared/model/app.ts`, registry entry in `src/shared/settings/registry.ts`,
  `app:setAiWritePolicy` handler following `app:setAiEnabled`.
- New `src/shared/model/provenance.ts`: `AI_AUTHORED_MARK = 'aiAuthored'`, attrs
  `{ runId, model, at, authorId }`; `provenanceEntrySchema { id, runId, chatId, authorId, model,
  at, mode, blockIndex|null, chars, excerpt, reason }`; `isTrivial(find, replace)` (punctuation /
  case-only, or edit distance ≤ 3 with equal word count).
- `document.ts` envelope: `provenance: z.array(provenanceEntrySchema).optional()` beside `lang`.
  `FORMAT_VERSIONS.document: 10`, migration 9→10 no-op with the usual reason (older build must open
  read-only rather than strip attribution).
- **Immutability at the write boundary:** `DocumentService.write` unions `previous.provenance` into
  the incoming envelope by `id`, never dropping, order preserved. The renderer only passes the
  envelope through. Schema comment states: the writer may delete the text; the entry stays.
- `assistantEdits.ts`: `mode:'direct'` splices text without suggestion marks but **with
  `aiAuthored`**; `mode:'suggest'` insertions carry `insertion` **and** `aiAuthored`, so accepting
  strips `insertion` and keeps attribution. `applyAssistantEdit` also returns `entries`; ids are
  minted main-side in the tool so both application paths write identical entries. Renderer path:
  `documentStore.appendProvenance(docId, entries)` merges before the next save; main path:
  `ai:applyEdit` appends before `write`.
- Policy decided in main at emit time: `direct-trivial` → `direct` only when `isTrivial` and the op
  came from `proofread` with kind spelling/punctuation; otherwise `suggest`.
- Editor extension `src/renderer/panels/editor/extensions/provenance.ts`: `Mark.create({ name:
  'aiAuthored', inclusive:false, keepOnSplit:true, excludes:'' })` rendering
  `<span class="pub-ai-authored" data-run data-model data-at title="Written by the assistant (model, date)">`
  with a dotted underline theme token. Guard plugin in the same file: `appendTransaction` maps old
  `aiAuthored` ranges through `tr.mapping` and re-adds the mark where the text survived unmarked
  (covers clear-formatting, `unsetAllMarks`, paste-over). Deleting text stays allowed. Register in
  `createEditor.ts`.
- DOCX: `EDITOR_MARK_TYPES` += `aiAuthored`; export emits one Word comment per `runId` run
  ("Written by the assistant (model, date)") through the existing thread→comment path in
  `toDocx.ts` (no second comment writer); `fromDocx` documented no-op; closed-world fixture gains
  an `aiAuthored` run.
- Display: mark tooltip; Review panel gains a "Written by the assistant" section listing
  `provenance` entries (excerpt, model, date, jump by `blockIndex`) with the note that entries
  remain after the text is removed.

Tests: `provenance.test.ts` (`isTrivial`), `assistantEdits.test.ts` direct mode + entries,
`documentService.test.ts` (write cannot drop entries), `migrate.test.ts` 9→10, `toDocx.test.ts`
closed-world + comment, extension guard with a live editor (`namedStyles.test.ts` style). E2E:
policy `direct` + stub `suggest_edit` → text changes immediately with `.pub-ai-authored`, the file's
`provenance` has one entry; delete the text, save, entry persists.

---

## Phase 5 — Web access gate, search abstraction, research tools

- Settings (app-scoped): `aiWebAccess: 'none'|'urls'|'search'` (default `none`),
  `aiSearchProvider: 'brave'|'tavily'|'searxng'` (default `brave`), `aiSearchBaseUrl` (SearXNG
  host). Registry entries + `app:setAiWeb` handler. `AiKeyStore` key id widened to
  `AiProviderId | 'search:<provider>'`; `ai:setKey`/`ai:keyStatus` schemas follow.
- `src/main/research/webSearch.ts`: `SearchProvider { id, name, needsKey, keyUrl?, search(query,
  limit, { apiKey, baseUrl, fetchImpl }) }`, `SEARCH_PROVIDERS` = Brave (default: single GET,
  header token, plain JSON, no SDK — matches `providers.ts`' plain-fetch stance), Tavily (POST),
  SearXNG (self-hosted `?format=json`, no key). All take an injected `fetchImpl` like `capture.ts`.
- `src/main/ai/webGate.ts`: `buildWebGate(level, writerUrls)` → `{ level, canSearch, allows(url) }`;
  `isPublicHttpUrl` rejects non-http(s), localhost, RFC1918, link-local, `.local` (SSRF guard, plus
  size cap + timeout in the fetch impl). `urls` level: writer URLs = URLs in this chat's user
  messages + `session.sources.list()` URLs. `toolSpecs({ retrieval, web })` omits `web_search`
  unless `search`, omits `fetch_page`/`cite_page` when `none` (never offer a tool that always refuses).
- Tools: `web_search { query, limit≤10 }` → numbered hits, creates nothing; `fetch_page { url }` →
  gate → `capturePage` → clipped text, stored in `context.captures`; `cite_page { url, claim,
  title?, author?, year? }` → refuses unless fetched this run → `sources.addProvisional` with
  `applyCaptureToCslFields` + capture attachment in the research library. Still provisional (the
  writer accepts it), but the card shows "Captured on <date>, text attached" instead of
  "attributed — not verified" (keyed off the presence of a capture attachment). `add_source` keeps
  its wording and stays the only path when nothing was fetched. `SOURCE_WRITING_TOOLS += cite_page`.
- Chip "Research this" (needs selection; shown only when web level ≠ none).

Tests: `webSearch.test.ts` per provider against fixture JSON; `webGate.test.ts` (private IPs, level
matrix); `tools.test.ts` `cite_page` refusal without fetch, attachment created. E2E: local HTTP page
served by the test, level `urls` with the URL in the writer's message → fetch succeeds, a different
URL is refused, source appears provisional with attachment.

---

## Phase 6 — Prompts and writing help, project-aware

- `src/main/ai/projectContext.ts` `buildProjectBrief(session, activeDocPath?)`: project type, title,
  document count, record names by kind (≤50), outline-stage beats, open review threads on the active
  doc; bounded ~1 500 chars; prepended to `settings.systemPrompt` in `ai:send`. `ai:dailyPrompt`
  uses it when a project is open (`promptRequest(angle, brief?)` in `writingPrompt.ts`).
- Read-only tools: `list_beats { status }` (`beats.snapshot()`, `entityIds` resolved to names for
  display), `read_outline {}` (`manuscript.view()` + beats by column). No `draft_beat`: beats have
  no `provisional` flag, so Phase 15's invariant cannot be enforced by `BeatService`; that is its own
  phase with a beats format bump.
- `src/shared/model/assistantTasks.ts` replaces `PROMPT_PRESETS`:
  `AssistantTask { id, title, needs: 'none'|'document'|'selection', requires?: 'web', prompt(ctx) }`
  with `review`, `proofread`, `research`, `prompt` (project-rooted writing prompt using
  `PROMPT_ANGLES`), `exercise` (aimed at an open comment or outline beat), `outline-next`
  (`read_outline`, proposes next beats in prose), `continue` (`suggest_edit` with empty `find`).

Tests: `projectContext.test.ts` (truncation, name cap), `tools.test.ts`, `writingPrompt.test.ts`.
E2E: chip prompt contains the active path; `list_beats` shows in the trail.

---

## Phase 7 — Panel as assistant (minimum viable redesign)

`AiPanel.tsx`: header "Assistant"; chip row from `assistantTasks.ts` filtered by availability
(active doc, selection, web level); composer unchanged. Run trail entries for edits link to the
document and block (reuse `revealBlock` in `editorActions.ts`); comment entries open the Review
panel. Settings form: provider/model/key as today, then **Web access** (select + provider + key
when `search`), **Write policy** (select, one explanatory line), retrieval manager always visible.
Both new settings read/write `appStore` (app-scoped). `DockRoot.tsx`/`panelRegistry.tsx`: rename
labels only; `aiEnabled` gating unchanged. Remove `PROMPT_PRESETS`, `EditProposalCard`, the per-chat
`agent` override UI; keep per-chat provider/model overrides. Update README's AI section and
`docs/ROADMAP.md` (new phase entry) so docs and code agree again.

E2E `ai.spec.ts`: chips present, settings persist across reopen; `ai-optional.spec.ts` semantics
unchanged (AI off hides everything).

---

## Out of scope

Real-time grammar underlines; LanguageTool/Hunspell; dedupe with Chromium's spellchecker; fetching
PDFs from the web; JS-rendered pages or browser automation; search caching; provenance
reconstruction on DOCX import; beats/maps/notes writing tools; raising `MAX_STEPS`; multi-document
autonomous rewrites; MCP/third-party tool servers.

## Verification (per phase, and before each PR)

- `npm run typecheck` and `npm test` after every phase.
- The named `e2e/*.spec.ts` files under `xvfb-run -a npm run e2e` (build first) for every phase,
  since each touches the editor, IPC, or a persisted renderer feature.
- `toDocx.test.ts` closed-world test must pass after Phase 4 (new mark).
- `bash ci/run-checks.sh --skip-package` against committed history before opening/updating a PR;
  draft PR per phase, each shippable alone.
- Manual: with a real provider, run "Review this document" on a chapter and confirm comments and
  suggestions appear in the Review panel attributed to "Assistant"; set write policy to `direct`,
  run "Proofread", delete a corrected word, reopen the project and confirm the provenance entry
  remains; set web access to `urls`, paste a URL, run "Research this" and confirm the source card
  shows the capture date.

## Critical files

- `src/main/ai/tools.ts`, `src/main/ai/agentRunner.ts`, new `src/main/ai/history.ts`,
  `proofread.ts`, `webGate.ts`, `projectContext.ts`; `src/main/research/webSearch.ts` (new)
- `src/shared/pm/assistantEdits.ts` (new; built on `anchors.ts` + `extractText.ts`)
- `src/shared/model/ai.ts`, `author.ts`, `document.ts`, `app.ts`, new `provenance.ts`,
  `assistantTasks.ts`; `src/shared/constants.ts`; `src/shared/model/migrate.ts`
- `src/shared/ipc/contract.ts` + `channels.ts`; `src/main/ipc/registerHandlers.ts` (`ai:send`
  L1397-1489, `doc:write` L482-497, new `ai:applyEdit`, `app:setAi*`)
- `src/main/services/reviewService.ts`, `documentService.ts`, `aiKeyStore.ts`
- `src/renderer/panels/ai/AiPanel.tsx`, new `applyEdit.ts`; `src/renderer/stores/chatStore.ts`,
  `documentStore.ts`, `appStore.ts`; `src/renderer/panels/editor/editorActions.ts`,
  `extensions/provenance.ts` (new), `createEditor.ts`
- `src/main/docx/toDocx.ts`, `fromDocx.ts`, `toDocx.test.ts`
- `e2e/ai-agent.spec.ts`, `ai.spec.ts`, `review.spec.ts`, `docx.spec.ts`
