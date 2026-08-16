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
  document: [],
  manifest: [],
  manuscript: [],
  entities: [],
  beats: [],
  maps: [],
  layouts: [],
  chats: [],
  connections: []
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
