# Phase 4 — Project templates

The build plan for [`ROADMAP.md`](./ROADMAP.md)'s Phase 4. Phases 0–3 are already shipped (format
governance, settings/menus, notes, fields/footnotes); this is the first phase in the "beyond
fiction" arc and the one Phase 6 (Beyond fiction) depends on.

## Why now

Nothing about supporting a thesis or a screenplay needs new editor machinery — it needs a
different *starting point*: different styles, a different panel layout, maybe seed entity kinds.
Phase 6 wants to offer "Thesis", "Essay", "Screenplay" alongside the existing default. The
cleanest way to get there is the one the roadmap commits to: **a template is just a project,
serialised.** No template DSL, no second schema to keep in sync with the project format — a
template *is* a `.thepub/project.json` plus whatever else the author chose to include, and
`templateService.instantiate` writes it through the same `VfsAdapter` every other project write
goes through.

## Part 1 — `projectType` on the manifest

### `src/shared/model/manifest.ts`

`projectManifestSchema` today is `{ formatVersion, id, name, created, modified, settings, styles
}` — no field says what *kind* of project this is. Add:

```ts
projectType: z.enum(['novel', 'thesis', 'essay', 'screenplay']).default('novel')
```

`'novel'` is the default so every project created before this phase round-trips unchanged.
Phase 6 will extend this enum; nothing here depends on the later members existing.

### `src/shared/constants.ts` / `src/shared/model/migrate.ts`

Bump `FORMAT_VERSIONS.manifest` from `1` to `2` and add the migration step — even though zod's
`.default('novel')` makes old manifests parse correctly without one, the house rule (see
`CLAUDE.md`) is that *every* on-disk shape change for a kind gets a counter bump and a step, so a
build that only checks the version number (rather than re-deriving defaults) never misreads an
old file:

```ts
{ from: 1, to: 2, up: (raw) => ({ ...raw, projectType: raw.projectType ?? 'novel' }) }
```

## Part 2 — Template format

A template directory mirrors a project's `.thepub/` layout, minus anything document-specific:

```
<template>/
  template.json        # { name, description, projectType, formatVersion }
  project.json          # manifest fragment: styles + settings only, no id/created/modified
  layouts.json           # optional — a starting dock layout
  entities.json           # optional — seed entity kinds / example records
  <opt-in project files>  # only if the author chose to include them when saving
```

`template.json` is new and small on purpose — it is metadata about the template, not a
project file, so it does not participate in `FORMAT_VERSIONS`/`MIGRATIONS` at all; it is read
once, at instantiate time, by a version of the app that always matches the template's writer.

## Part 3 — `templateService.ts` (new, `src/main/services/`)

```ts
class TemplateService {
  async list(): Promise<TemplateSummary[]>          // built-in + user, merged, built-in first
  async instantiate(templateId: string, targetUri: string, name: string): Promise<void>
  async saveAsTemplate(session: ProjectSession, opts: SaveTemplateOptions): Promise<void>
}
```

- `list()` reads built-in templates from the packaged `resources/templates/` directory (see Part
  4) and user templates from `userData/templates/`, each a subdirectory matching the shape above.
- `instantiate` does *not* reuse `ProjectSession.open`'s `loadOrCreateManifest` path directly —
  it composes it: `createAdapter(targetUri)`, `adapter.mkdir(PUB_DIR)`, then copies the template's
  `project.json` into a fresh manifest with a new `id: ulid()`, `created`/`modified` set to now,
  and the caller-supplied `name` — exactly the fields a template must *not* carry over literally.
  `layouts.json` and `entities.json`, if present in the template, are copied byte-for-byte (they
  have no per-project identity to regenerate). This is the same `VfsAdapter` every other project
  write goes through, which is what makes instantiating onto SFTP, FTP or OneDrive free — no
  branch anywhere in `templateService` checks which backend it's writing to.
- `saveAsTemplate` is the inverse: given an open `ProjectSession`, snapshot `manifest.styles` and
  `manifest.settings` into a fresh `project.json`, always include them, and copy any of
  `entities.json` / `beats.json` / `maps.json` / a chosen set of `.pubdoc` files only if the
  caller opted in (`SaveTemplateOptions.include: { entities?: boolean; documents?: string[] }`).
  Nothing is included by default beyond styles and settings — a template with someone's draft
  chapter three in it by accident is the failure mode this guards against.

## Part 4 — Packaging and storage locations

No precedent exists yet for shipping arbitrary JSON assets in the packaged app —
`electron-builder.yml`'s `directories.buildResources: resources` only covers the app icon, and
`files:` lists just `out/**` and `package.json`. This phase adds:

```yaml
extraResources:
  - from: resources/templates
    to: templates
```

and a small path helper (main process only, alongside the existing `app.getPath('userData')`
call sites in `appState.ts` / `aiKeyStore.ts` / `connectionStore.ts`):

```ts
function builtinTemplatesDir() {
  return path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'templates' : 'resources/templates')
}
function userTemplatesDir() {
  return path.join(app.getPath('userData'), 'templates')
}
```

The dev/packaged split matters here specifically because `electron-vite dev` never runs
electron-builder, so `process.resourcesPath` doesn't contain `resources/templates` until a real
build does.

Ships with one built-in template to start: the current default (`novel`) project, captured as
`resources/templates/novel/`, so `list()` and `instantiate` have a real fixture from day one
rather than a stub. Phase 6 adds `thesis`/`essay`/`screenplay` alongside it — those are template
authoring changes, not `templateService` changes.

## Part 5 — IPC and the "New Project from Template" flow

### `src/shared/ipc/channels.ts` and `contract.ts`

Two new invoke channels, added to both files together (the `_InvokeChannelsMatch` compile-time
guard catches a mismatch):

```ts
'templates:list': { req: z.void(), res: z.array(templateSummarySchema) }
'templates:instantiate': { req: z.object({ templateId: z.string(), targetUri: z.string(), name: z.string() }), res: z.object({ ok: z.boolean() }) }
```

### `src/main/ipc/registerHandlers.ts`

`handle('templates:list', () => templateService.list())` and
`handle('templates:instantiate', ({ templateId, targetUri, name }) => templateService.instantiate(templateId, targetUri, name))`
— `templateService` is constructed once at app startup alongside the other app-level singletons
(it has no per-project state, unlike `EntityService` and friends, which live on `ProjectSession`).

### Renderer

A "New Project from Template…" command (`registerCommand`, following the existing
`panel.settings`-style registrations in `DockRoot.tsx`) opens a picker — reusing the existing
"files" mode plumbing in `CommandPalette.tsx` is the cheapest path, or a small dedicated dialog if
the picker needs template descriptions/previews the palette doesn't render. On confirm: pick a
target folder (existing native save/open dialog IPC), call `templates:instantiate`, then open the
new project through the normal open-project flow — `templateService` does not itself open a
`ProjectSession`.

## Part 6 — Layout preset from `projectType`

`LayoutService` has no notion of "the preset for a new project" today — `layouts.json` starts
empty (`{ lastLayout: null, presets: [] }`) and the renderer falls back to a hardcoded default
arrangement. Since a template's `layouts.json` (if present) is copied verbatim into the new
project by `instantiate`, this falls out for free: a template that ships a `lastLayout` gives its
instantiated projects that starting layout with no code in `LayoutService` needing to know
`projectType` exists at all. `projectType` only needs to reach the *renderer* — e.g. to pick which
panels (`panelRegistry.ts`) are offered by default — which is Phase 6's concern, not this one's.

## Not needed after all

The roadmap sketches extracting a shared `jsonCollectionService.ts` base out of `EntityService` /
`BeatService` / `MapService`. That refactor is listed under Phase 5 (Citations), which is the
phase that actually needs a fourth clone (`sourceService.ts`) to justify it — doing it here would
be speculative generalisation for a consumer that doesn't exist yet.

## Verification

- `bash ci/run-checks.sh` — typecheck, vitest and Playwright.
- New unit tests: `templateService.instantiate` writes a manifest with a fresh `id`/`created` and
  the caller's `name`, while `styles`/`settings` match the template; `saveAsTemplate` excludes
  `entities.json`/documents when `include` is omitted and includes them when opted in; manifest
  migration `1 → 2` defaults `projectType` to `'novel'` on an old file.
- New e2e test: "New Project from Template" end-to-end — pick the built-in `novel` template,
  confirm the resulting project opens with its styles and (if the template ships one) its layout,
  and that editing it never writes back into `resources/templates/`.
- Manual: `npm run build` and confirm `resources/templates/` actually lands in the packaged
  output at the expected path — this is the one part of this phase `npm run dev` cannot verify,
  since dev never runs electron-builder.
