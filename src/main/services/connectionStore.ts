import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { ulid } from 'ulid'
import {
  connectionFileSchema,
  connectionProfileSchema,
  type ConnectionFile,
  type ConnectionProfile
} from '../../shared/model/connection.js'
import { migrate } from '../../shared/model/migrate.js'
import { FORMAT_VERSIONS } from '../../shared/constants.js'

interface StoredFile extends ConnectionFile {
  /** Encrypted secrets by profile id. Written here, never read by anything else. */
  secrets?: Record<string, string>
}

/**
 * Saved servers, in the user's data directory.
 *
 * In userData rather than any project, because a server is a property of the
 * person and their machine — and because a project folder syncing to that very
 * server must not contain the credentials for reaching it.
 *
 * Profiles handed out never carry the secret. `hasSecret` is a boolean, and the
 * only code that sees a password is the adapter that opens the connection.
 */
export class ConnectionStore {
  private file(): string {
    return path.join(app.getPath('userData'), 'connections.json')
  }

  /**
   * True when the file on disk was written by a newer build.
   *
   * Read fresh on each call rather than cached: this store has no lifecycle to
   * hang a cache on, and the file is small.
   */
  readOnly(): boolean {
    return this.read().tooNew
  }

  private read(): StoredFile & { tooNew: boolean } {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as unknown
      const { value, tooNew } = migrate('connections', raw)
      // A file this build cannot understand is not parsed against this build's
      // schema at all. Its profiles may name a protocol that does not exist
      // here, and the enum would reject the whole file — which the `catch`
      // below would then quietly turn into "you have no saved servers".
      if (tooNew) {
        return {
          formatVersion: FORMAT_VERSIONS.connections,
          connections: [],
          secrets: (raw as StoredFile).secrets ?? {},
          tooNew: true
        }
      }
      const parsed = connectionFileSchema.parse(value)
      return { ...parsed, secrets: (raw as StoredFile).secrets ?? {}, tooNew: false }
    } catch {
      return { formatVersion: FORMAT_VERSIONS.connections, connections: [], secrets: {}, tooNew: false }
    }
  }

  private write(stored: StoredFile): void {
    // Nothing overwrites a file written by a newer build. Doing so would drop
    // every profile whose protocol this build has never heard of — silently,
    // and for good.
    if (this.readOnly()) {
      throw new Error(
        'Your saved servers were written by a newer version of The Pub, so they cannot be changed here.'
      )
    }
    fs.mkdirSync(path.dirname(this.file()), { recursive: true })
    fs.writeFileSync(
      this.file(),
      JSON.stringify({ ...stored, formatVersion: FORMAT_VERSIONS.connections }, null, 2),
      { mode: 0o600 }
    )
  }

  list(): ConnectionProfile[] {
    return this.read().connections
  }

  get(id: string): ConnectionProfile | null {
    return this.read().connections.find((profile) => profile.id === id) ?? null
  }

  /**
   * Create or update a profile. `secret` is written only when given, so saving
   * an edited profile does not require retyping the password.
   */
  save(incoming: Partial<ConnectionProfile> & { id?: string }, secret?: string): ConnectionProfile {
    const stored = this.read()
    const now = new Date().toISOString()
    const existing = incoming.id
      ? stored.connections.find((profile) => profile.id === incoming.id)
      : undefined

    const secrets = stored.secrets ?? {}
    const id = existing?.id ?? incoming.id ?? ulid()
    if (secret !== undefined) {
      if (secret === '') delete secrets[id]
      // A password is dropped rather than written in the clear when there is no
      // keychain — a project folder that syncs to the very server it holds the
      // credentials for is the case this rule exists for. The profile still
      // saves, and `hasSecret` below reports the truth, which is what the
      // connect dialog shows; it also warns before anything is typed, from
      // `secureStorageAvailable`.
      else if (this.secureStorageAvailable()) {
        secrets[id] = safeStorage.encryptString(secret).toString('base64')
      }
    }

    const profile = connectionProfileSchema.parse({
      ...existing,
      ...incoming,
      id,
      hasSecret: Boolean(secrets[id]),
      created: existing?.created ?? now,
      modified: now
    })

    stored.connections = existing
      ? stored.connections.map((candidate) => (candidate.id === id ? profile : candidate))
      : [...stored.connections, profile]
    stored.secrets = secrets
    this.write(stored)
    return profile
  }

  remove(id: string): void {
    const stored = this.read()
    stored.connections = stored.connections.filter((profile) => profile.id !== id)
    // The secret goes with the profile; a later profile reusing the id would
    // otherwise inherit a password its owner never set.
    if (stored.secrets) delete stored.secrets[id]
    this.write(stored)
  }

  /** The decrypted secret. Main process only — no channel returns this. */
  secret(id: string): string | null {
    const encrypted = this.read().secrets?.[id]
    if (!encrypted) return null
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return null
    }
  }

  secureStorageAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }
}
