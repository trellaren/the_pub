import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import {
  fingerprint,
  hostKeyAlgorithm,
  hostKeyId,
  judgeHostKey,
  hostKeyRefusal,
  KnownHostsPolicy,
  type KnownHost
} from './hostKeys.js'

/**
 * The host-key decision, tested where it is pure.
 *
 * Standing up a machine-in-the-middle to prove that an intercepted connection
 * is refused would be elaborate and would still only cover one shape of attack.
 * The decision itself is three values in and one out, so the interesting cases —
 * unknown, changed, matched, and a key of a different algorithm — are all
 * reachable here. `sftpAdapter.test.ts` then proves the adapter really asks.
 */

/**
 * Whether OpenSSH is on this machine to compare against.
 *
 * Reported as a skip rather than a silent pass: a cross-check that quietly
 * no-ops where the tool is missing reads as coverage in the run output while
 * proving nothing, which is worse than an honest gap. The digest arithmetic is
 * covered unconditionally by the first test below either way.
 */
function hasSshKeygen(): boolean {
  try {
    execFileSync('ssh-keygen', ['-l', '-f', '/nonexistent'], { stdio: 'ignore' })
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** A public key blob in SSH wire format: length-prefixed name, then the body. */
function blob(algorithm: string, body: string): Buffer {
  const name = Buffer.from(algorithm, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(name.length, 0)
  return Buffer.concat([length, name, Buffer.from(body, 'utf8')])
}

describe('fingerprint', () => {
  it('is base64 of the sha256 of the key, without padding', () => {
    const key = blob('ssh-ed25519', 'the key body')
    const expected = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')

    expect(fingerprint(key)).toBe(`SHA256:${expected}`)
    expect(fingerprint(key)).not.toMatch(/=/)
  })

  it('differs for keys that differ by one byte', () => {
    expect(fingerprint(blob('ssh-ed25519', 'aaaa'))).not.toBe(fingerprint(blob('ssh-ed25519', 'aaab')))
  })

  /*
   * The format is the whole point of showing a fingerprint at all: an author is
   * meant to compare the string this app prints against one they obtained from
   * the server another way, and the way they will have obtained it is OpenSSH's.
   * A prettier format would be unverifiable, which would make the prompt
   * theatre. So this asks `ssh-keygen` itself, where there is one to ask.
   */
  it.skipIf(!hasSshKeygen())('matches what ssh-keygen prints for the same key', () => {
    const parsed = ssh2.utils.parseKey(ssh2.utils.generateKeyPairSync('ed25519').public)
    if (parsed instanceof Error) throw parsed
    const key = parsed.getPublicSSH()

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-fp-'))
    try {
      const file = path.join(dir, 'id_ed25519.pub')
      fs.writeFileSync(file, `${parsed.type} ${key.toString('base64')} pub\n`)
      const printed = execFileSync('ssh-keygen', ['-lf', file], { encoding: 'utf8' })
      expect(printed).toContain(fingerprint(key))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('hostKeyAlgorithm', () => {
  it('reads the name from the head of the blob', () => {
    expect(hostKeyAlgorithm(blob('ssh-ed25519', 'x'))).toBe('ssh-ed25519')
    expect(hostKeyAlgorithm(blob('ecdsa-sha2-nistp256', 'x'))).toBe('ecdsa-sha2-nistp256')
  })

  /*
   * A malformed key must be refused, not crash the handshake on the way there —
   * so this reports `unknown`, which no stored entry can match, and the refusal
   * happens in the ordinary way.
   */
  it('reports unknown for anything malformed rather than throwing', () => {
    expect(hostKeyAlgorithm(Buffer.alloc(0))).toBe('unknown')
    expect(hostKeyAlgorithm(Buffer.from([0, 0, 0, 9]))).toBe('unknown')
    expect(hostKeyAlgorithm(Buffer.from([0, 0, 0, 0]))).toBe('unknown')
    expect(hostKeyAlgorithm(blob('with\u0000nulls', 'x'))).toBe('unknown')
    // A length field larger than any real algorithm name.
    const absurd = Buffer.alloc(4)
    absurd.writeUInt32BE(4_000_000_000, 0)
    expect(hostKeyAlgorithm(Buffer.concat([absurd, Buffer.alloc(16)]))).toBe('unknown')
  })
})

describe('hostKeyId', () => {
  it('names a host and port the way OpenSSH does', () => {
    expect(hostKeyId('example.com', 22)).toBe('[example.com]:22')
    expect(hostKeyId('example.com', 2222)).toBe('[example.com]:2222')
  })

  /* Hostnames are case-insensitive; two spellings must not be two identities. */
  it('folds case in the host', () => {
    expect(hostKeyId('Example.COM', 22)).toBe(hostKeyId('example.com', 22))
  })

  /* And a different port is a different server, which is the point of including it. */
  it('separates ports', () => {
    expect(hostKeyId('example.com', 22)).not.toBe(hostKeyId('example.com', 2022))
  })
})

describe('judgeHostKey', () => {
  const stored: KnownHost = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:aaa', added: '2026-01-01' }

  it('trusts an exact match', () => {
    expect(judgeHostKey([stored], { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:aaa' })).toBe('trusted')
  })

  it('calls an empty store unknown', () => {
    expect(judgeHostKey([], { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:aaa' })).toBe('unknown')
  })

  it('calls a different fingerprint for the same algorithm a change', () => {
    expect(judgeHostKey([stored], { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:bbb' })).toBe('changed')
  })

  /*
   * The false-positive this design exists to avoid. A server commonly holds
   * several host keys, and which is offered depends on what the client asks for
   * — which shifts when the SSH library is upgraded. Comparing across
   * algorithms would turn a routine upgrade into "your server has been
   * replaced", and an alarm that cries wolf is one authors learn to dismiss.
   */
  it('calls a key of an algorithm it has never seen unknown, not changed', () => {
    expect(judgeHostKey([stored], { algorithm: 'ssh-rsa', fingerprint: 'SHA256:bbb' })).toBe('unknown')
  })

  it('finds the right entry when several algorithms are stored', () => {
    const rsa: KnownHost = { algorithm: 'ssh-rsa', fingerprint: 'SHA256:ccc', added: '2026-01-01' }
    expect(judgeHostKey([stored, rsa], { algorithm: 'ssh-rsa', fingerprint: 'SHA256:ccc' })).toBe('trusted')
    expect(judgeHostKey([stored, rsa], { algorithm: 'ssh-rsa', fingerprint: 'SHA256:ddd' })).toBe('changed')
  })
})

describe('the refusal message', () => {
  const presented = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:presented' }

  /*
   * These strings are the entire user interface for this feature on the failure
   * path, so they are worth asserting on. A warning nobody can act on is a
   * warning nobody heeds: each has to name the fingerprint and the next step.
   */
  it('tells an author what to compare and where, for an unknown host', () => {
    const message = hostKeyRefusal('unknown', 'books.example.com', presented).message
    expect(message).toContain('books.example.com')
    expect(message).toContain('SHA256:presented')
    expect(message).toContain('Servers')
  })

  it('names both fingerprints and says nothing was sent, for a changed host', () => {
    const stored: KnownHost = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:stored', added: '2026-01-01' }
    const message = hostKeyRefusal('changed', 'books.example.com', presented, stored).message
    expect(message).toContain('SHA256:presented')
    expect(message).toContain('SHA256:stored')
    expect(message).toMatch(/nothing has been sent/i)
    expect(message).toMatch(/intercepting/i)
  })
})

describe('KnownHostsPolicy', () => {
  const key = blob('ssh-ed25519', 'the real server')

  it('accepts a key the store holds', () => {
    const policy = new KnownHostsPolicy({
      get: () => [{ algorithm: 'ssh-ed25519', fingerprint: fingerprint(key), added: '2026-01-01' }]
    })
    expect(policy.check('example.com', 22, key)).toEqual({ ok: true })
  })

  /*
   * There is deliberately no trust-on-first-use here. Accepting the first key
   * seen would protect against an attacker who turns up later while being wide
   * open to one already in place, and the author would never learn a decision
   * had been made on their behalf.
   */
  it('refuses a first connection rather than accepting it silently', () => {
    const policy = new KnownHostsPolicy({ get: () => [] })
    const decision = policy.check('example.com', 22, key)
    expect(decision).toMatchObject({ ok: false, verdict: 'unknown', previous: '' })
  })

  it('looks the host up by host and port', () => {
    const asked: string[] = []
    const policy = new KnownHostsPolicy({
      get: (id) => {
        asked.push(id)
        return []
      }
    })
    policy.check('Example.com', 2222, key)
    expect(asked).toEqual(['[example.com]:2222'])
  })

  it('reports the previously accepted fingerprint when the key has changed', () => {
    const policy = new KnownHostsPolicy({
      get: () => [{ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:whatWasThereBefore', added: '2026-01-01' }]
    })
    const decision = policy.check('example.com', 22, key)
    expect(decision).toMatchObject({
      ok: false,
      verdict: 'changed',
      previous: 'SHA256:whatWasThereBefore',
      presented: { algorithm: 'ssh-ed25519', fingerprint: fingerprint(key) }
    })
  })
})
