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
import { FORMAT_VERSION } from '../../shared/constants.js'

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

  private read(): StoredFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as unknown
      const parsed = connectionFileSchema.parse(raw)
      return { ...parsed, secrets: (raw as StoredFile).secrets ?? {} }
    } catch {
      return { formatVersion: FORMAT_VERSION, connections: [], secrets: {} }
    }
  }

  private write(stored: StoredFile): void {
    fs.mkdirSync(path.dirname(this.file()), { recursive: true })
    fs.writeFileSync(this.file(), JSON.stringify(stored, null, 2), { mode: 0o600 })
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
      else if (safeStorage.isEncryptionAvailable()) {
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
