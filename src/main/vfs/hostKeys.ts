import { createHash } from 'node:crypto'

/**
 * Deciding whether the server on the other end is the one we meant to reach.
 *
 * SSH encrypts the channel from the first exchange, but encryption alone says
 * nothing about *who* is on the other end: anything that can answer on the
 * host and port gets an encrypted session with the author, and then reads the
 * manuscript and the password in the clear. The host key is the only thing that
 * distinguishes the real server from something standing in front of it, and it
 * is worthless unless somebody checks it.
 *
 * The check is deliberately split from where the answer is stored: everything
 * here is pure, so the interesting cases — an unknown host, a key that has
 * changed, a key that matches — are settled by unit tests rather than by
 * standing up a machine-in-the-middle.
 */

/** One host key an author has accepted, as stored. */
export interface KnownHost {
  /** The SSH algorithm name, e.g. `ssh-ed25519`. */
  algorithm: string
  /** OpenSSH's `SHA256:…` form. */
  fingerprint: string
  /** ISO timestamp, so the store can be read and audited by a person. */
  added: string
}

export type HostKeyVerdict = 'trusted' | 'unknown' | 'changed'

/** What the adapter learns about the key it was offered. */
export interface PresentedHostKey {
  algorithm: string
  fingerprint: string
}

export type HostKeyDecision =
  | { ok: true }
  | {
      ok: false
      verdict: Exclude<HostKeyVerdict, 'trusted'>
      /** What the server offered, for the dialog to show. */
      presented: PresentedHostKey
      /** What had been accepted before, when this is a change; empty otherwise. */
      previous: string
      error: Error
    }

/**
 * The question the adapter asks mid-handshake.
 *
 * A required constructor field on `SftpConnection` rather than an optional one,
 * which is the point: an optional verifier is a verifier somebody forgets, and
 * forgetting it fails open. Every construction site has to name a policy, and a
 * test that wants to skip the check has to say so in the test.
 */
export interface HostKeyPolicy {
  check(host: string, port: number, key: Buffer): HostKeyDecision
}

/** Read access to the accepted keys. Implemented by `KnownHostsStore`. */
export interface KnownHostsReader {
  get(hostId: string): KnownHost[]
}

/** How a host is named in the store. Matches OpenSSH's `[host]:port` convention. */
export function hostKeyId(host: string, port: number): string {
  return `[${host.toLowerCase()}]:${port}`
}

/**
 * OpenSSH's SHA256 fingerprint of a public key blob.
 *
 * The exact format matters and is worth pinning: it is what `ssh-keygen -lf`
 * and the banner OpenSSH prints on first connect both show, so an author can
 * compare the string this app displays against one they obtained from the
 * server by some other route. A prettier or shorter format would be
 * unverifiable, which would make the whole prompt theatre.
 */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/**
 * The algorithm name from the head of an SSH public key blob.
 *
 * Every SSH public key is a length-prefixed string naming its algorithm
 * followed by algorithm-specific fields, so the name is the first field and
 * needs no crypto to read. Returns `unknown` rather than throwing for anything
 * malformed: a garbled key must be *refused*, and refusal is the caller's
 * business, but it must not crash the handshake on the way there.
 */
export function hostKeyAlgorithm(key: Buffer): string {
  if (key.length < 4) return 'unknown'
  const length = key.readUInt32BE(0)
  if (length === 0 || length > 64 || key.length < 4 + length) return 'unknown'
  const name = key.subarray(4, 4 + length).toString('utf8')
  return /^[\x20-\x7e]+$/.test(name) ? name : 'unknown'
}

export function describeHostKey(key: Buffer): PresentedHostKey {
  return { algorithm: hostKeyAlgorithm(key), fingerprint: fingerprint(key) }
}

/**
 * Compare what the server offered against what has been accepted before.
 *
 * Keys are matched *by algorithm*, and that is the load-bearing detail. A
 * server commonly holds several host keys — an Ed25519 and an RSA one — and
 * which of them is offered depends on what the client asks for, which can
 * change when the SSH library is upgraded. Comparing across algorithms would
 * turn that routine event into "the server's identity has changed", and a
 * warning that cries wolf is a warning authors learn to click through.
 *
 * So: same algorithm and same fingerprint is trusted; same algorithm and a
 * different fingerprint is the real alarm; anything else is simply not yet
 * known, which is refused too, just without the accusation.
 */
export function judgeHostKey(known: readonly KnownHost[], presented: PresentedHostKey): HostKeyVerdict {
  const forAlgorithm = known.find((entry) => entry.algorithm === presented.algorithm)
  if (!forAlgorithm) return 'unknown'
  return forAlgorithm.fingerprint === presented.fingerprint ? 'trusted' : 'changed'
}

/**
 * The refusal an author reads.
 *
 * ssh2 reports a rejected host key as a bare handshake failure, which is
 * indistinguishable from the server being misconfigured. These messages replace
 * it, and each one names the fingerprint and the next step — a warning nobody
 * can act on is a warning nobody heeds.
 */
export function hostKeyRefusal(
  verdict: Exclude<HostKeyVerdict, 'trusted'>,
  host: string,
  presented: PresentedHostKey,
  stored?: KnownHost
): Error {
  if (verdict === 'changed') {
    return new Error(
      `The identity of ${host} has changed. It now offers a ${presented.algorithm} key with ` +
        `fingerprint ${presented.fingerprint}, but this machine has previously accepted ` +
        `${stored?.fingerprint ?? 'a different key'}. Either the server was rebuilt, or something ` +
        `is intercepting the connection. Nothing has been sent to it. Check with whoever runs the ` +
        `server before accepting the new key in Servers.`
    )
  }
  return new Error(
    `The identity of ${host} has not been verified. It offers a ${presented.algorithm} key with ` +
      `fingerprint ${presented.fingerprint}. Open Servers, choose Test, and accept the fingerprint ` +
      `if it matches the one you expect.`
  )
}

/**
 * The policy the app runs: accept only what the author has accepted before.
 *
 * There is no trust-on-first-use here — the first connection to an unknown host
 * is refused like any other, and accepting it is a separate, deliberate act in
 * the connect dialog. Auto-accepting the first key would protect against an
 * attacker who turns up later while being wide open to one already in place,
 * and the author would never learn a decision had been made for them.
 */
export class KnownHostsPolicy implements HostKeyPolicy {
  constructor(private readonly hosts: KnownHostsReader) {}

  check(host: string, port: number, key: Buffer): HostKeyDecision {
    const presented = describeHostKey(key)
    const known = this.hosts.get(hostKeyId(host, port))
    const verdict = judgeHostKey(known, presented)
    if (verdict === 'trusted') return { ok: true }
    const stored = known.find((entry) => entry.algorithm === presented.algorithm)
    return {
      ok: false,
      verdict,
      presented,
      previous: verdict === 'changed' ? (stored?.fingerprint ?? '') : '',
      error: hostKeyRefusal(verdict, host, presented, stored)
    }
  }
}
