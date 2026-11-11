import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { FORMAT_VERSIONS } from '../../shared/constants.js'
import { migrate } from '../../shared/model/migrate.js'
import { writeFileAtomicSync } from './atomicFile.js'
import type { KnownHost, KnownHostsReader, PresentedHostKey } from '../vfs/hostKeys.js'

const knownHostSchema = z.object({
  algorithm: z.string(),
  fingerprint: z.string(),
  added: z.string()
})

const knownHostsFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.knownHosts),
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
  /** `file` is for tests; the app always uses userData. */
  constructor(private readonly filePath?: string) {}

  private file(): string {
    return this.filePath ?? path.join(app.getPath('userData'), 'known_hosts.json')
  }

  /**
   * Missing means nothing trusted yet. Unparseable content is set aside as
   * `.corrupt-*` rather than read as empty and then overwritten by the next
   * `trust` — that would silently forget every other server. A read *error*
   * propagates: it says nothing about the file's contents.
   */
  private read(): { stored: KnownHostsFile; tooNew: boolean } {
    const empty = (): KnownHostsFile => ({ formatVersion: FORMAT_VERSIONS.knownHosts, hosts: {} })
    let text: string
    try {
      text = fs.readFileSync(this.file(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stored: empty(), tooNew: false }
      throw error
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return { stored: this.quarantine(empty()), tooNew: false }
    }
    const { value, tooNew } = migrate('knownHosts', json)
    const parsed = knownHostsFileSchema.safeParse(value)
    if (tooNew) return { stored: parsed.success ? parsed.data : empty(), tooNew: true }
    return { stored: parsed.success ? parsed.data : this.quarantine(empty()), tooNew: false }
  }

  private quarantine(empty: KnownHostsFile): KnownHostsFile {
    fs.renameSync(this.file(), `${this.file()}.corrupt-${Date.now()}`)
    return empty
  }

  private readForWrite(): KnownHostsFile {
    const { stored, tooNew } = this.read()
    if (tooNew) {
      throw new Error('Trusted server keys were saved by a newer version of Quoth, so they cannot be changed here.')
    }
    return stored
  }

  private write(stored: KnownHostsFile): void {
    writeFileAtomicSync(
      this.file(),
      JSON.stringify({ ...stored, formatVersion: FORMAT_VERSIONS.knownHosts }, null, 2),
      0o600
    )
  }

  get(hostId: string): KnownHost[] {
    try {
      return this.read().stored.hosts[hostId] ?? []
    } catch {
      // Unreadable fails closed: every connection is refused until the author
      // accepts a fingerprint again.
      return []
    }
  }

  /**
   * Accept a key for a host, replacing any previous key of the same algorithm.
   *
   * Replacing rather than appending is what makes accepting a *changed* key
   * work, and it is the only way a stored key is ever overwritten — there is no
   * path that quietly adds one.
   */
  trust(hostId: string, presented: PresentedHostKey): void {
    const stored = this.readForWrite()
    const existing = stored.hosts[hostId] ?? []
    stored.hosts[hostId] = [
      ...existing.filter((entry) => entry.algorithm !== presented.algorithm),
      { ...presented, added: new Date().toISOString() }
    ]
    this.write(stored)
  }

  /** Drop every key for a host, so the next connection asks again. */
  forget(hostId: string): void {
    const stored = this.readForWrite()
    delete stored.hosts[hostId]
    this.write(stored)
  }
}
