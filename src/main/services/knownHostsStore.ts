import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { FORMAT_VERSION } from '../../shared/constants.js'
import type { KnownHost, KnownHostsReader, PresentedHostKey } from '../vfs/hostKeys.js'

const knownHostSchema = z.object({
  algorithm: z.string(),
  fingerprint: z.string(),
  added: z.string()
})

const knownHostsFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  hosts: z.record(z.string(), z.array(knownHostSchema)).default(() => ({}))
})
type KnownHostsFile = z.infer<typeof knownHostsFileSchema>

/**
 * The SSH host keys this machine has accepted.
 *
 * In userData beside `connections.json`, for the same reason: a server's
 * identity is a property of this machine and this person, and a project folder
 * that syncs to that very server must not carry the record of what the server
 * is supposed to be — an attacker who can write to the project could then
 * rewrite the answer to the question they are being asked.
 *
 * Unlike passwords this is stored in the clear, and deliberately. A public key
 * fingerprint is not a secret; it is a value an author is *meant* to be able to
 * read and compare against one they got from the server another way. Encrypting
 * it would make it unreadable to its owner while protecting nothing — what
 * matters is that the file cannot be *written*, which is what the 0600 mode and
 * userData's location give. This is exactly the reasoning behind OpenSSH's own
 * plaintext `known_hosts`, and the format here is deliberately close enough to
 * read side by side with one.
 */
export class KnownHostsStore implements KnownHostsReader {
  private file(): string {
    return path.join(app.getPath('userData'), 'known_hosts.json')
  }

  private read(): KnownHostsFile {
    try {
      return knownHostsFileSchema.parse(JSON.parse(fs.readFileSync(this.file(), 'utf8')))
    } catch {
      // An unreadable store means nothing is trusted, which fails closed: every
      // connection is refused until the author accepts a fingerprint again.
      return { formatVersion: FORMAT_VERSION, hosts: {} }
    }
  }

  private write(stored: KnownHostsFile): void {
    fs.mkdirSync(path.dirname(this.file()), { recursive: true })
    fs.writeFileSync(this.file(), JSON.stringify(stored, null, 2), { mode: 0o600 })
  }

  get(hostId: string): KnownHost[] {
    return this.read().hosts[hostId] ?? []
  }

  /**
   * Accept a key for a host, replacing any previous key of the same algorithm.
   *
   * Replacing rather than appending is what makes accepting a *changed* key
   * work, and it is the only way a stored key is ever overwritten — there is no
   * path that quietly adds one.
   */
  trust(hostId: string, presented: PresentedHostKey): void {
    const stored = this.read()
    const existing = stored.hosts[hostId] ?? []
    stored.hosts[hostId] = [
      ...existing.filter((entry) => entry.algorithm !== presented.algorithm),
      { ...presented, added: new Date().toISOString() }
    ]
    this.write(stored)
  }

  /** Drop every key for a host, so the next connection asks again. */
  forget(hostId: string): void {
    const stored = this.read()
    delete stored.hosts[hostId]
    this.write(stored)
  }
}
