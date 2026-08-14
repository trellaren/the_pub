import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import type { AiProviderId } from '../../shared/model/ai.js'

/**
 * API keys, encrypted at rest in the user's data directory.
 *
 * Two deliberate choices. Keys live in **userData, never the project folder**:
 * a project is a folder the author syncs, shares and often commits, and a key
 * that travels with the manuscript is a key that ends up in someone's git
 * history. And they are encrypted with the OS keychain through `safeStorage`,
 * so a file read is not enough to lift them.
 *
 * When the platform has no keychain available `safeStorage` cannot encrypt. In
 * that case nothing is written and the app says so, rather than quietly storing
 * plaintext under a name that implies otherwise.
 */
export class AiKeyStore {
  private cache = new Map<AiProviderId, string>()

  private file(): string {
    return path.join(app.getPath('userData'), 'ai-keys.json')
  }

  available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  private write(stored: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.file()), { recursive: true })
    fs.writeFileSync(this.file(), JSON.stringify(stored, null, 2), { mode: 0o600 })
  }

  /** Which providers have a key stored. Never the keys themselves. */
  configured(): AiProviderId[] {
    return Object.keys(this.read()) as AiProviderId[]
  }

  get(provider: AiProviderId): string | null {
    const cached = this.cache.get(provider)
    if (cached) return cached
    const encrypted = this.read()[provider]
    if (!encrypted) return null
    try {
      const key = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      this.cache.set(provider, key)
      return key
    } catch {
      // Written by another machine, or the keychain entry is gone.
      return null
    }
  }

  set(provider: AiProviderId, key: string): { ok: boolean; reason?: string } {
    const stored = this.read()
    if (!key) {
      delete stored[provider]
      this.cache.delete(provider)
      this.write(stored)
      return { ok: true }
    }
    if (!this.available()) {
      return {
        ok: false,
        reason: 'This system has no secure storage available, so the key was not saved.'
      }
    }
    stored[provider] = safeStorage.encryptString(key).toString('base64')
    this.cache.set(provider, key)
    this.write(stored)
    return { ok: true }
  }
}
