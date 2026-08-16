# Phase 8 — An embedded model

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 8: `prism-ml/bonsai-27b` running inside
the app, as a first-class AI provider that needs no key, no account and no network. It depends on
nothing from Phases 0–7 beyond what has shipped; it builds on the AI layer from the original
brief (`src/shared/model/ai.ts`, `src/main/ai/`, `src/main/services/chatService.ts`).

## Why

Today every AI feature except LM Studio sends manuscript text to a hosted provider. For a lot of
writers that is disqualifying — a draft is the most private thing they own — and LM Studio only
helps the subset willing to install and operate a second application. An embedded model closes
that gap: the passage being reviewed never leaves the machine, it works on a train, and it costs
nothing per token. Bonsai-27b is the right size for this: strong enough for the review/tighten/
brainstorm presets the panel actually ships, small enough to run quantised on a well-equipped
laptop.

## The integration decision: a managed `llama-server`, not in-process bindings

The model runs as a **llama.cpp `llama-server` child process on a loopback port**, spawned and
supervised by main, speaking its OpenAI-compatible API. Not `node-llama-cpp` or any other
in-process binding. Four reasons, all pointing the same way:

1. **The client side already exists.** `buildRequest` in `src/main/ai/providers.ts` has one
   branch that covers "OpenAI, Hugging Face's router and LM Studio" because they speak the same
   dialect — `llama-server` speaks it too. `SseParser`, `deltaFrom`, `AiRunner`, cancellation,
   the panel: all of it works unchanged. The embedded model is, to everything above the provider
   layer, LM Studio with a managed lifecycle.
2. **Crash isolation.** Inference is ~16 GB of native code under memory pressure. When it dies —
   and on a machine at the hardware floor it will — it must take a subprocess with it, not the
   main process and the author's unsaved manuscript.
3. **No native module in the app binary.** In-process bindings mean electron-rebuild across three
   platforms and two architectures, forever. Shipping prebuilt `llama-server` executables as
   resources is a packaging problem, which this repo already knows how to solve.
4. **GPU support for free.** Metal on macOS, CUDA/Vulkan on Windows and Linux are llama.cpp's
   per-platform builds doing what they already do, not our FFI configuration.

Precedent for both halves is in-tree: `src/main/server/rendererServer.ts` for a supervised
loopback server, and `src/main/onedrive/` for keeping the whole subsystem free of Electron
imports so it tests as pure logic.

## Part 1 — Weights: catalogue, store, download (`src/main/llm/`)

### `catalog.ts` (new)

A static table of the bonsai-27b quantisations the app offers, with everything the UI and the
gate need: file name, download URL, byte size, sha256, minimum memory.

```ts
export interface ModelVariant {
  id: string            // 'bonsai-27b-q4_k_m'
  label: string         // 'Standard (16 GB)'
  url: string           // prism-ml's own distribution, pinned to a revision
  bytes: number
  sha256: string
  minMemoryBytes: number
}
```

Two variants at launch — a Q4_K_M default (~16 GB) and a Q8_0 for machines that can carry it —
not a quantisation zoo. URLs pin an exact upstream revision so a re-download can never silently
fetch different weights than the checksum was written for.

**Weights are downloaded on first use, never bundled.** A 16 GB installer is not shippable, and
weights must live in **userData, never a project folder** — the same reasoning `AiKeyStore`
records for keys: a project is a folder the author syncs, shares and commits. One copy serves
every project. prism-ml's license is displayed and accepted before the first download starts, and
the accepted version is recorded alongside the weights.

### `modelStore.ts` (new)

Owns `userData/models/`: what is present, verified, partially downloaded, or removable, with the
free-disk preflight (size × 1.05, checked before a single byte moves — the failure to have at
15.9 GB is the one this exists for).

### `download.ts` (new)

Resumable download as pure logic with `fetch` injected, in the `onedrive/` style: HTTP Range
resume from a `.partial` file, sha256 accumulated as chunks arrive (not by re-reading 16 GB at
the end), progress callbacks, and cancel via `AbortSignal`. A checksum mismatch deletes the file
and reports plainly — a corrupt model that half-works is worse than one that failed loudly.

## Part 2 — The engine (`src/main/llm/engine.ts`)

### Binaries

`resources/llm/<platform>-<arch>/llama-server`, shipped through the same `extraResources` hook as
`resources/templates/` and `resources/csl/`. Pinned llama.cpp release; Metal build for
darwin-arm64, Vulkan + CPU for win32/linux x64. Tens of megabytes, which the installer can
absorb.

### Lifecycle

A small state machine — `absent → downloading → ready → starting → running → idle-stopped`,
with `error` reachable from each — because every state is something the panel must render, not
an internal detail:

- **Lazy start.** Spawned on the first request that resolves to the embedded provider, on an
  ephemeral port, with a readiness poll before the request is forwarded. Cold start on a 27B is
  seconds to tens of seconds; the panel shows "warming up", never a silent hang.
- **Idle shutdown** after a configurable interval (default 10 minutes) — 16 GB of RAM held by an
  app the author has tabbed away from is how The Pub gets blamed for a slow machine.
- **Killed on quit**, unconditionally.
- **Crash → error event** on the in-flight request through the existing `StreamEvent` error path,
  and the engine returns to `ready` so the next send retries. No automatic restart loop.

### The hardware gate

`os.totalmem()` against `minMemoryBytes`, at download time and again at start. Below the floor,
the variant is refused with a plain sentence, not offered-and-broken. No GPU probing — llama.cpp
falls back to CPU on its own, and a wrong VRAM guess is worse than no guess.

## Part 3 — Provider wiring

### `src/shared/model/ai.ts`

`aiProviderIds` gains `'embedded'`. The file's own comment — "everything above this layer is
identical for all of them" — is the design being cashed in. `PROVIDERS` gains an entry with
`needsKey: false` and `defaultModel: 'prism-ml/bonsai-27b'`; its `baseUrl` is resolved at request
time in main from the engine's actual port (the renderer never needs to know it).

### `src/main/services/chatService.ts`

Where settings resolve to `provider: 'embedded'`: ensure the engine is running (starting the
download is a UI act, not a side effect of pressing send — if weights are absent the request
fails with a "not downloaded" error the panel turns into the download affordance), fill in the
port, and hand off to `AiRunner` unchanged.

### Format bump

An older build parsing a chats file whose `provider` is `'embedded'` fails the zod enum and takes
the corrupt-rename path — exactly the data-loss class `migrate.ts` exists to stop. Bump
`FORMAT_VERSIONS.chats` 1 → 2 with a no-op step in `MIGRATIONS.chats`, so the too-new guard makes
older builds open the file read-only instead.

## Part 4 — IPC and UI

- Channels (in `channels.ts` + `contract.ts` together, per the `_InvokeChannelsMatch` guard):
  `llm:status`, `llm:download`, `llm:cancelDownload`, `llm:remove`, plus a pushed
  `llm:progress` event stream mirroring the `ai:stream` pattern.
- The provider picker in `AiPanel.tsx` / the settings UI lists "Embedded — private, works
  offline". Selecting it before weights exist shows the variant choice (with the hardware gate's
  verdict), license, and a download progress bar that survives panel close — the download belongs
  to main, the panel only watches it.
- Hosted providers remain the default; the embedded model is offered, not imposed.

## Deliberately out of scope

Fine-tuning, RAG/embedding indexes over the manuscript, automatic hosted-vs-local routing, and a
second embedded model. One model, one integration, done properly.

## Verification

- `bash ci/run-checks.sh`.
- Unit: resumable download against an injected fetch serving Range responses (including a resume
  after a mid-file abort); checksum mismatch deletes and errors; disk preflight; hardware gate
  against fake totals; engine state machine with a fake child process (spawn, readiness, idle
  timer, crash mid-stream); the chats migration step.
- E2E: a stub `llama-server` (a script speaking just enough of the dialect to stream a canned
  reply) placed where the engine expects the binary — send a message through the real panel with
  the embedded provider and assert the streamed reply lands and cancellation works. The stub is
  the point: e2e must not need 16 GB of weights.
- Manual, on a real machine with real weights: cold start, generation quality sanity, cancel
  mid-generation, quit during download and confirm resume, idle shutdown observed in a process
  monitor.
