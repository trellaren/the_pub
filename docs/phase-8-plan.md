# Phase 8 — An embedded model, a choice of them, or none

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 8. It depends on nothing from Phases 0–7
beyond what has shipped; it builds on the AI layer from the original brief
(`src/shared/model/ai.ts`, `src/main/ai/`, `src/main/services/chatService.ts`).

The phase delivers three postures, and a writer picks one:

1. **AI off.** Not "AI ignored" — off. No panel, no menu items, no presets, no processes, no
   network calls. The Pub as a plain writing tool.
2. **An embedded model** — the writer's pick from a small curated catalogue, downloaded once,
   running inside the app as the project's routine agent: the model that answers whenever a
   feature asks for AI. No key, no account, no network, and not a word of the manuscript leaves
   the machine.
3. **Hosted providers**, exactly as today.

Postures 2 and 3 are the existing provider picker doing its job. Posture 1 is new, and sits
*above* the picker.

## Part 1 — The off switch

### `aiEnabled`, app-scoped

A single boolean in the app state (`src/main/services/appState.ts`, userData) — **the person's
setting, never the project's**. This matters more once Phase 9 exists: a shared project's
`chats.json` names a provider, and a collaborator who has opted out of AI must not have that
choice overridden by a folder someone sent them. A project can carry conversations; it cannot
switch AI on.

### What "off" removes

- The AI panel is not offered in the dock, and its menu and command-palette entries are not
  built — removed from the menu model, not disabled in place. A greyed-out "Ask AI" is still an
  AI product; the point of this posture is that the product is a word processor.
- The prompt presets, the "send selection to AI" affordances, everything.
- No `llama-server` is ever spawned, nothing is downloaded, no provider is ever called.

### What "off" preserves

`chats.json` and stored keys are untouched, not deleted — flipping the switch back restores every
conversation. And there is nothing to uninstall, because nothing AI-shaped ships in the
installer: weights were download-on-demand from the start (Part 3), so posture 1 costs zero bytes
and posture 2's cost is paid only by the people who choose it.

The switch lives in the Settings panel with the AI section itself; first run of a fresh install
asks once, plainly, with "off" an equal option rather than a buried opt-out.

## The engine decision: one managed `llama-server`, model-agnostic

Embedded models run as a **llama.cpp `llama-server` child process on a loopback port**, spawned
and supervised by main, speaking its OpenAI-compatible API. Not in-process bindings. Four
reasons, all pointing the same way:

1. **The client side already exists.** `buildRequest` in `src/main/ai/providers.ts` has one
   branch covering "OpenAI, Hugging Face's router and LM Studio" because they speak the same
   dialect — `llama-server` speaks it too. `SseParser`, `deltaFrom`, `AiRunner`, cancellation,
   the panel: unchanged. An embedded model is, to everything above the provider layer, LM Studio
   with a managed lifecycle.
2. **Crash isolation.** Inference is gigabytes of native code under memory pressure; when it
   dies it must take a subprocess with it, not the main process and unsaved manuscript.
3. **No native module in the app binary** — no electron-rebuild across three platforms forever.
4. **GPU support for free** from llama.cpp's own per-platform builds (Metal on darwin-arm64,
   Vulkan + CPU elsewhere).

The same decision quietly buys the *choice* of models: `llama-server` is model-agnostic — GGUF
in, tokens out — so supporting several models costs catalogue entries, not engine code.

Precedent for both halves is in-tree: `src/main/server/rendererServer.ts` for a supervised
loopback server, `src/main/onedrive/` for keeping a subsystem free of Electron imports so it
tests as pure logic.

## Part 2 — The catalogue (`src/main/llm/catalog.ts`)

A static, curated table — data, not code:

```ts
export interface EmbeddedModel {
  id: string                  // 'bonsai-27b'
  name: string                // 'Bonsai 27B'
  vendor: string              // 'prism-ml'
  license: { name: string; url: string }
  contextLength: number
  variants: ModelVariant[]    // quantisations
}
export interface ModelVariant {
  id: string                  // 'bonsai-27b-q4_k_m'
  label: string               // 'Standard (16 GB)'
  url: string                 // vendor's own distribution, pinned to a revision
  bytes: number
  sha256: string
  minMemoryBytes: number
}
```

Three models at launch, spanning the hardware range rather than the leaderboard:

- **`prism-ml/bonsai-27b`** — the flagship and the recommendation, for machines that can carry
  ~16 GB (Q4_K_M) or ~28 GB (Q8_0).
- **A mid-size (~9B)** and **a small (~4B)** open-weights instruct model, so a writer on 16 GB
  or 8 GB of RAM gets a private, offline routine agent instead of a refusal. Exact picks are a
  curation decision at build time, held to the same bar: open weights, a license that permits
  this distribution, and instruct tuning good enough for the panel's presets.

Every URL pins an exact upstream revision so a re-download can never fetch different weights
than the checksum was written for. Each model's license is shown and accepted before its first
download, and the acceptance recorded beside the weights.

**Which model is the routine agent** rides plumbing that already exists: `aiSettings.model` —
for `provider: 'embedded'`, it holds a catalogue id, and `providerInfo`'s `defaultModel` is
`'bonsai-27b'`. Project defaults and per-chat overrides come along free, because
`resolveSettings` already merges them — one conversation can use the small model for quick
questions while the project default stays on the 27B.

**Sideloading, deliberately minimal:** any local `.gguf` can be used by pointing the model
setting at a file path. The engine does not care, so refusing would be artificial — but
sideloaded files get no checksum, no hardware gate beyond a file-size heuristic, and no support
promise. The catalogue is the product; the escape hatch is an escape hatch.

## Part 3 — Weights on disk (`modelStore.ts`, `download.ts`)

- **`userData/models/<modelId>/<variantId>.gguf`** — never bundled (multi-gigabyte installers
  are not a thing), never in a project folder (the `AiKeyStore` reasoning: projects are synced,
  shared and committed). One copy serves every project; several models may coexist, each
  individually removable, with disk usage shown per model in the manager UI.
- `modelStore.ts` owns presence, verification state, partial downloads, and removal, plus the
  free-disk preflight (size × 1.05 before a byte moves — failing at 15.9 of 16 GB is the case
  this exists for).
- `download.ts` is pure logic with `fetch` injected, in the `onedrive/` style: HTTP Range resume
  from a `.partial` file, sha256 accumulated as chunks arrive (not by re-reading gigabytes at
  the end), progress callbacks, cancel via `AbortSignal`. A checksum mismatch deletes and
  reports plainly — a corrupt model that half-works is worse than one that failed loudly.

## Part 4 — The engine (`src/main/llm/engine.ts`)

### Binaries

`resources/llm/<platform>-<arch>/llama-server`, shipped through the same `extraResources` hook
as `resources/templates/` and `resources/csl/`, from a pinned llama.cpp release. Tens of
megabytes; the installer can absorb it, and it is inert under posture 1.

### Lifecycle

A small state machine — `absent → downloading → ready → starting → running → idle-stopped`,
`error` reachable from each — because every state is something the UI must render:

- **Lazy start** on the first request resolving to `embedded`, on an ephemeral port, readiness
  polled before the request is forwarded. Cold start is seconds to tens of seconds; the panel
  shows "warming up", never a silent hang.
- **One model loaded at a time.** RAM is the reason; a request naming a different embedded model
  than the one running triggers a graceful stop and a fresh start, surfaced as the same warming
  state. Running two models at once is explicitly not offered.
- **Idle shutdown** after a configurable interval (default 10 minutes) — gigabytes of RAM held
  by a tabbed-away app is how The Pub gets blamed for a slow machine.
- **Killed on quit**, unconditionally. **Crash →** an error event on the in-flight request
  through the existing `StreamEvent` error path, engine back to `ready`, no automatic restart
  loop.

### The hardware gate

`os.totalmem()` against the variant's `minMemoryBytes`, at download time and again at start —
per variant, which is what makes the small-model catalogue entries meaningful: on an 8 GB
machine the 27B is refused with a plain sentence *and the 4B is offered*, instead of the whole
feature being broken-or-absent. No GPU probing: llama.cpp falls back to CPU on its own, and a
wrong VRAM guess is worse than none.

## Part 5 — Provider wiring

- `src/shared/model/ai.ts`: `aiProviderIds` gains `'embedded'`; `PROVIDERS` gains an entry with
  `needsKey: false`. Its `baseUrl` is resolved at request time in main from the engine's actual
  port — the renderer never needs to know it. The file's own comment — "everything above this
  layer is identical for all of them" — is the design being cashed in.
- `chatService.ts`, where settings resolve to `embedded`: check `aiEnabled` (defence in depth —
  the UI should make this unreachable), map the model id to weights on disk, ensure the engine
  is running *if the weights exist* — absent weights fail with a "not downloaded" error the
  panel turns into the download affordance; pressing send is never what starts a 16 GB download
  — then hand to `AiRunner` unchanged.
- **Format bump:** an older build parsing a chats file whose provider is `'embedded'` fails the
  zod enum and takes the corrupt-rename path — the exact data-loss class `migrate.ts` exists to
  stop. `FORMAT_VERSIONS.chats` 1 → 2 with a no-op step in `MIGRATIONS.chats`, so the too-new
  guard opens it read-only instead.

## Part 6 — IPC and UI

- Channels, added to `channels.ts` + `contract.ts` together (the `_InvokeChannelsMatch` guard):
  `llm:status`, `llm:download`, `llm:cancelDownload`, `llm:remove` — each taking a model/variant
  id — plus a pushed `llm:progress` stream mirroring the `ai:stream` pattern. And
  `ai:enabled:read` / `ai:enabled:update` for the master switch, which the renderer reads before
  registering any AI surface.
- **A models manager** in the Settings panel's AI section: the catalogue with per-model status
  (not downloaded / downloading with progress / ready / active), the hardware gate's verdict per
  variant, license links, disk usage, and remove. Downloads belong to main and survive the panel
  closing; quit-and-relaunch resumes.
- The provider picker groups the catalogue under "Embedded — private, works offline". Hosted
  providers remain available and the default for existing projects; nothing is imposed in either
  direction.

## Deliberately out of scope

- **Agentic behaviour.** The routine agent answers when asked — chat, presets, selection
  context. It does not autonomously edit documents, run background tasks over the manuscript, or
  use tools. Every one of those is a real feature with real trust questions, and none belongs
  inside a phase whose job is model plumbing.
- Fine-tuning, RAG/embedding indexes, automatic hosted-vs-local routing, concurrent models, and
  in-app curation of models beyond the shipped catalogue (a catalogue update is an app update).

## Verification

- `bash ci/run-checks.sh`.
- Unit: resumable download against an injected fetch serving Range responses, including resume
  after mid-file abort; checksum mismatch deletes and errors; disk preflight; per-variant
  hardware gate against fake totals (27B refused, 4B offered); engine state machine with a fake
  child process — spawn, readiness, idle timer, crash mid-stream, and the stop/start sequence on
  model switch; store bookkeeping with several models present; the chats migration step.
- E2E, with a stub `llama-server` (a script speaking just enough of the dialect to stream a
  canned reply) placed where the engine expects the binary: send a message through the real
  panel via the embedded provider, assert the streamed reply and cancellation; switch the chat
  to a second stub model and assert the restart is surfaced, not silent. And the off switch:
  disable AI, restart the app, assert no AI panel, no AI menu items, and no engine process;
  re-enable and assert prior chats return intact.
- Manual, on real machines with real weights: cold start and generation sanity on the 27B and
  the small model; cancel mid-generation; quit during a download and confirm resume; idle
  shutdown observed in a process monitor; the 8 GB-machine path — 27B gated, 4B downloadable and
  usable.
