import { FORMAT_VERSIONS, type FileKind } from '../constants.js'

export interface MigrationStep {
  from: number
  to: number
  up: (raw: unknown) => unknown
}

/**
 * Steps that bring an on-disk file forward to the version this build expects.
 *
 * Empty today — no format has ever broken compatibility — but every future
 * breaking change registers a step here rather than inventing its own ad hoc
 * upgrade path. Steps are applied in order, one version at a time, so a file
 * three versions behind still upgrades correctly without a step that jumps
 * three at once.
 */
export const MIGRATIONS: Record<FileKind, MigrationStep[]> = {
  document: [
    // Phase 3 adds the `field` node type; nothing about a v1 document's own
    // shape changes, so this exists only to carry the version forward. An
    // older build would otherwise treat any v1 document as already current
    // and silently drop `field` nodes it re-saves, which is the exact loss
    // Phase 0's version check exists to prevent.
    { from: 1, to: 2, up: (raw) => raw },
    // Phase 3b adds the `footnote` node type; same reasoning as the step above.
    { from: 2, to: 3, up: (raw) => raw },
    // Phase 5 adds the `citation` and `bibliography` field kinds, plus three
    // new (optional) `field` attrs. No v3 document's own shape changes, so
    // this too exists only to carry the version forward.
    { from: 3, to: 4, up: (raw) => raw },
    // Phase 7 adds `sections`. Same reasoning again: absent already means
    // "the project's default page setup, no headers or footers", so no
    // existing v4 document's own shape changes — only the version, so an
    // older build doesn't silently re-save a v5 document as v4 and drop a
    // header an author just wrote.
    { from: 4, to: 5, up: (raw) => raw },
    // Phase 9 adds the `insertion` and `deletion` marks. An older build must
    // open a document under review read-only rather than stripping the marks
    // and autosaving the loss — which would silently accept every pending
    // insertion and reject every pending deletion, with nothing to undo it by.
    { from: 5, to: 6, up: (raw) => raw },
    // Phase 11 adds the lazily-allocated `highlightId` attr to the `highlight`
    // mark. No v6 document's own shape changes — an existing highlight has no
    // id and stays that way until collected — so this exists only to carry
    // the version forward, for the reason the steps above already record.
    { from: 6, to: 7, up: (raw) => raw }
  ],
  manifest: [
    // Phase 4 adds `projectType`. The schema's own default would fill it in
    // regardless, so this step changes nothing about the value — it exists so
    // the *version* moves, which is what stops a build that predates templates
    // from treating a v2 manifest as one it fully understands.
    { from: 1, to: 2, up: (raw) => raw },
    // Phase 5 adds `settings.citationStyleId`. Same reasoning: an older build
    // would otherwise re-save a v3 manifest as v2 and silently drop the
    // project's chosen citation style.
    { from: 2, to: 3, up: (raw) => raw },
    // Phase 6 adds `numbering` and `cycleStyle` to entries in `styles`. Same
    // reasoning again: no existing style's own shape changes, so this exists
    // only to carry the version forward.
    { from: 3, to: 4, up: (raw) => raw },
    // Phase 6 also adds `entityKinds`. The schema's own `undefined` default
    // (read as "the fiction defaults") fills in regardless, so again nothing
    // about the value changes — only the version, so an older build doesn't
    // silently re-save a v5 manifest as v4 and drop a project's custom kinds.
    { from: 4, to: 5, up: (raw) => raw },
    // Phase 11 adds `highlightCategories`. The schema's own `undefined`
    // default (read as "no project-defined categories yet") fills in
    // regardless, so again nothing about the value changes — only the
    // version, for the same reason `entityKinds` moved it above.
    { from: 5, to: 6, up: (raw) => raw },
    // Phase 12 adds the `publication` block (subtitle, author display name,
    // publisher, ISBN, etc). The schema's own `prefault({})` fills it in
    // regardless, so nothing about the value changes — only the version, so
    // an older build doesn't silently re-save a v7 manifest as v6 and drop
    // publication metadata an author just entered.
    { from: 6, to: 7, up: (raw) => raw }
  ],
  manuscript: [],
  entities: [],
  beats: [],
  maps: [],
  layouts: [],
  chats: [
    // Phase 8 adds the `embedded` provider id. No v1 chat's own shape changes,
    // but a build that predates it fails `aiProviderIdSchema`'s enum on a file
    // naming it — and `ChatService.load` renames an unparseable file to
    // `.corrupt-*`, which would lose every conversation in the project. The
    // version moving is what routes that build through the too-new guard
    // instead.
    { from: 1, to: 2, up: (raw) => raw },
    // Phase 10b adds `toolCalls` to a message and `agent` to settings. Both
    // default to empty, so again nothing about an existing value changes —
    // only the version, for the same reason as the step above.
    { from: 2, to: 3, up: (raw) => raw },
    // Phase 10b's retrieval index adds `embedModel` to settings, which defaults
    // to empty and means "the provider's own default". Same reasoning again:
    // the value is harmless to an older build, but the rename-on-unparseable
    // path is not, so the version moves.
    { from: 3, to: 4, up: (raw) => raw }
  ],
  connections: [
    // Phase 10a adds the `db` protocol and its engine/database/schema fields. A
    // build that predates it fails `connectionProtocolSchema`'s enum on a file
    // naming one — and `ConnectionStore.read` treats an unparseable file as an
    // empty one, so it would silently drop *every saved server*, not only the
    // new profile. The version moving is what turns that into a read-only
    // refusal instead. This is the highest-value line in Track A.
    { from: 1, to: 2, up: (raw) => raw }
  ],
  notes: [],
  sources: [],
  authors: [],
  reviews: [],
  presence: [],
  highlights: []
}

export interface MigrationResult {
  value: unknown
  /** At least one step ran. The caller should treat the file as changed even if not yet re-saved. */
  migrated: boolean
  /** The file's own version exceeds what this build knows about — never safe to migrate or overwrite. */
  tooNew: boolean
}

/**
 * Bring a raw, not-yet-validated file up to date before its schema parses it.
 *
 * Reads `formatVersion` defensively, off the untyped JSON, because a file this
 * build cannot yet understand is exactly the file whose shape a schema built
 * for *this* build has no business asserting on first.
 */
export function migrate(kind: FileKind, raw: unknown): MigrationResult {
  const current = FORMAT_VERSIONS[kind]
  const diskVersion = readFormatVersion(raw)

  if (diskVersion === null) return { value: raw, migrated: false, tooNew: false }
  if (diskVersion > current) return { value: raw, migrated: false, tooNew: true }
  if (diskVersion === current) return { value: raw, migrated: false, tooNew: false }

  let value = raw
  let version = diskVersion
  let migrated = false
  for (const step of MIGRATIONS[kind]) {
    if (step.from !== version) continue
    value = step.up(value)
    version = step.to
    migrated = true
  }
  return { value, migrated, tooNew: false }
}

function readFormatVersion(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = (raw as { formatVersion?: unknown }).formatVersion
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}
