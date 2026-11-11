import path from 'node:path'
import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import { projectManifestSchema, type ProjectManifest } from '../../shared/model/manifest.js'
import { migrate } from '../../shared/model/migrate.js'
import { BUILTIN_STYLES } from '../../shared/model/style.js'
import { MANIFEST_FILE, PUB_DIR, FORMAT_VERSIONS } from '../../shared/constants.js'
import { jsonBytes } from './versionedJson.js'

export async function loadOrCreateManifest(
  adapter: VfsAdapter
): Promise<{ manifest: ProjectManifest; readOnly: boolean }> {
  const existing = await adapter.stat(MANIFEST_FILE)
  if (existing) {
    // A read failure propagates: an unreachable manifest is not a corrupt one.
    const raw = await adapter.readFile(MANIFEST_FILE)
    let json: unknown
    try {
      json = JSON.parse(raw.toString('utf8'))
    } catch {
      json = undefined
    }
    if (json !== undefined) {
      const { value, tooNew } = migrate('manifest', json)
      const parsed = projectManifestSchema.safeParse(value)
      if (tooNew) {
        // Never renamed or replaced: a manifest this build cannot read may
        // still be perfectly good to the build that wrote it.
        if (!parsed.success) {
          throw new Error(
            'This project was saved by a newer version of Quoth in a form this version cannot read. Update Quoth to open it.'
          )
        }
        return { manifest: parsed.data, readOnly: true }
      }
      if (parsed.success) return { manifest: parsed.data, readOnly: false }
    }
    // Keep the unreadable manifest rather than deleting it — it may hold
    // styles the author wants back — and continue with a fresh one.
    await adapter.rename(MANIFEST_FILE, `${MANIFEST_FILE}.corrupt-${Date.now()}`)
  }
  const manifest = createManifest(path.basename(adapter.root))
  await writeManifest(adapter, manifest)
  return { manifest, readOnly: false }
}

export function createManifest(name: string): ProjectManifest {
  const now = new Date().toISOString()
  return projectManifestSchema.parse({
    formatVersion: FORMAT_VERSIONS.manifest,
    id: ulid(),
    name,
    created: now,
    modified: now,
    settings: {},
    styles: BUILTIN_STYLES
  })
}

export async function writeManifest(adapter: VfsAdapter, manifest: ProjectManifest): Promise<void> {
  await adapter.mkdir(PUB_DIR)
  await adapter.writeFileAtomic(MANIFEST_FILE, jsonBytes(manifest))
}
