import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * Resumable, verified download of a model file.
 *
 * Pure logic with `fetch` and the filesystem injected, following
 * `src/main/onedrive/`: nothing here imports Electron, so the whole of it —
 * including resume after an interrupted transfer, which is the part that
 * actually breaks — is testable without a browser or a real network.
 *
 * Two properties are worth stating because getting either wrong is expensive at
 * this file size:
 *
 * - **The digest is accumulated as bytes arrive**, never by re-reading the
 *   finished file. A second pass over 16 GB is a minute of disk for a value we
 *   already had in hand. On resume the hash is seeded by re-reading only what
 *   is already on disk, which is the one unavoidable read.
 * - **The partial file is the resume state.** No sidecar bookkeeping to fall out
 *   of step with the bytes; its length *is* the offset to ask for.
 */

export interface DownloadTarget {
  url: string
  /** Final destination. The partial lives at `${destination}.partial`. */
  destination: string
  /** Expected size, used for progress and as a sanity check on the response. */
  bytes: number
  /** Expected digest, or empty when the catalogue has none to check against. */
  sha256: string
}

export interface DownloadDeps {
  fetch: typeof globalThis.fetch
  /** Injected so tests need no temp directories; defaults to `node:fs`. */
  fs?: Pick<typeof fs.promises, 'stat' | 'open' | 'rename' | 'rm' | 'mkdir'>
}

export type VerifyState = 'verified' | 'mismatch' | 'unverified'

export interface DownloadResult {
  ok: boolean
  verify: VerifyState
  bytes: number
  /** Set when `ok` is false. Written to be shown to a person verbatim. */
  error?: string
}

export interface DownloadOptions {
  signal?: AbortSignal
  onProgress?: (receivedBytes: number, totalBytes: number) => void
}

const partialPath = (destination: string): string => `${destination}.partial`

/**
 * Bytes already fetched, or 0 when there is nothing to resume from.
 *
 * A partial longer than the expected total is not a resume, it is a different
 * file under the same name — a catalogue entry re-pointed at a new revision is
 * the realistic way to get one — so it starts again rather than appending to
 * something it cannot explain.
 */
async function resumeOffset(
  io: NonNullable<DownloadDeps['fs']>,
  destination: string,
  expectedBytes: number
): Promise<number> {
  try {
    const stat = await io.stat(partialPath(destination))
    if (!stat.isFile()) return 0
    return stat.size > 0 && stat.size < expectedBytes ? stat.size : 0
  } catch {
    return 0
  }
}

/** Seed the running hash with what a previous attempt already wrote. */
async function seedHash(
  io: NonNullable<DownloadDeps['fs']>,
  destination: string,
  offset: number
): Promise<crypto.Hash> {
  const hash = crypto.createHash('sha256')
  if (offset === 0) return hash
  const handle = await io.open(partialPath(destination), 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let read = 0
    while (read < offset) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, offset - read), read)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      read += bytesRead
    }
  } finally {
    await handle.close()
  }
  return hash
}

export async function downloadModel(
  target: DownloadTarget,
  deps: DownloadDeps,
  options: DownloadOptions = {}
): Promise<DownloadResult> {
  const io = deps.fs ?? fs.promises
  let received = await resumeOffset(io, target.destination, target.bytes)

  let response: Response
  try {
    response = await deps.fetch(target.url, {
      signal: options.signal ?? null,
      // Byte ranges are how this resumes. A server that ignores the header
      // answers 200 with the whole file, which is handled below rather than
      // being appended to what is already there.
      headers: received > 0 ? { range: `bytes=${received}-` } : {}
    })
  } catch (error) {
    return {
      ok: false,
      verify: 'unverified',
      bytes: received,
      error: describeNetwork(error)
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      verify: 'unverified',
      bytes: received,
      error: `The download failed with status ${response.status}.`
    }
  }

  // 200 to a ranged request means the server sent the whole file regardless, so
  // the partial is stale and everything restarts. 206 is a real resume.
  const resuming = received > 0 && response.status === 206
  if (!resuming) received = 0

  const hash = await seedHash(io, target.destination, received)
  const total = target.bytes > 0 ? target.bytes : received + Number(response.headers.get('content-length') ?? 0)

  if (!response.body) {
    return { ok: false, verify: 'unverified', bytes: received, error: 'The download returned no data.' }
  }

  const handle = await io.open(partialPath(target.destination), resuming ? 'r+' : 'w')
  try {
    let position = received
    for await (const chunk of streamOf(response.body)) {
      hash.update(chunk)
      await handle.write(chunk, 0, chunk.length, position)
      position += chunk.length
      received = position
      options.onProgress?.(received, total)
    }
  } catch (error) {
    // A cancelled or dropped transfer keeps the partial: it is exactly what the
    // next attempt resumes from, and deleting it would throw away the only
    // thing that makes a 16 GB download survivable on a bad connection.
    return {
      ok: false,
      verify: 'unverified',
      bytes: received,
      error: options.signal?.aborted ? 'The download was stopped.' : describeNetwork(error)
    }
  } finally {
    await handle.close()
  }

  const digest = hash.digest('hex')
  const verify: VerifyState = !target.sha256
    ? 'unverified'
    : digest === target.sha256.toLowerCase()
      ? 'verified'
      : 'mismatch'

  if (verify === 'mismatch') {
    // A corrupt model that half-works is worse than one that failed loudly, so
    // the bytes go rather than being left to be resumed into permanence.
    await io.rm(partialPath(target.destination), { force: true })
    return {
      ok: false,
      verify,
      bytes: 0,
      error: 'The downloaded file did not match its published checksum, so it was discarded.'
    }
  }

  await io.rename(partialPath(target.destination), target.destination)
  return { ok: true, verify, bytes: received }
}

/** Iterate a web stream as Buffers, which is what `write` wants. */
async function* streamOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    if (value) yield Buffer.from(value)
  }
}

function describeNetwork(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return 'The connection failed. The download will carry on from where it stopped when you try again.'
  }
  return message
}
