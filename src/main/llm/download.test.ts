import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { downloadModel } from './download.js'

let dir: string
let destination: string

const BODY = Buffer.from('the quick brown fox jumps over the lazy dog, repeatedly and at length')
const DIGEST = crypto.createHash('sha256').update(BODY).digest('hex')

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-llm-'))
  destination = path.join(dir, 'model.gguf')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * A server that honours `Range`, so resume is exercised against the behaviour
 * a real CDN has rather than against a mock that always returns everything.
 */
function serving(body: Buffer, options: { ignoreRange?: boolean; cutAfter?: number } = {}) {
  const calls: (string | null)[] = []
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.['range'] ?? null
    calls.push(range)
    const offset = !options.ignoreRange && range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
    const slice = body.subarray(offset)
    const chunk = options.cutAfter !== undefined ? slice.subarray(0, options.cutAfter) : slice
    let sent = false

    return {
      ok: true,
      status: offset > 0 && !options.ignoreRange ? 206 : 200,
      headers: new Headers({ 'content-length': String(chunk.length) }),
      // Delivered through `pull` rather than enqueued-then-errored in `start`:
      // erroring a stream discards whatever is still queued, so the latter
      // would test a transfer that dropped *before* any bytes arrived — which
      // is not the case resume exists for.
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true
            controller.enqueue(new Uint8Array(chunk))
            return
          }
          if (options.cutAfter !== undefined) controller.error(new Error('connection reset'))
          else controller.close()
        }
      })
    } as unknown as Response
  }) as unknown as typeof globalThis.fetch

  return { fetch: fetchImpl, calls }
}

describe('downloadModel', () => {
  it('writes the file and reports it verified when the digest matches', async () => {
    const server = serving(BODY)
    const result = await downloadModel(
      { url: 'https://example/model', destination, bytes: BODY.length, sha256: DIGEST },
      { fetch: server.fetch }
    )

    expect(result.ok).toBe(true)
    expect(result.verify).toBe('verified')
    expect(await fs.readFile(destination)).toEqual(BODY)
    // No sidecar bookkeeping left behind: the partial *is* the resume state.
    await expect(fs.stat(`${destination}.partial`)).rejects.toThrow()
  })

  it('reports unverified rather than verified when the catalogue has no digest', async () => {
    const server = serving(BODY)
    const result = await downloadModel(
      { url: 'https://example/model', destination, bytes: BODY.length, sha256: '' },
      { fetch: server.fetch }
    )

    expect(result.ok).toBe(true)
    expect(result.verify).toBe('unverified')
  })

  it('discards the bytes when the digest disagrees', async () => {
    const server = serving(BODY)
    const result = await downloadModel(
      { url: 'https://example/model', destination, bytes: BODY.length, sha256: 'a'.repeat(64) },
      { fetch: server.fetch }
    )

    expect(result.ok).toBe(false)
    expect(result.verify).toBe('mismatch')
    // A corrupt model that half-works is worse than one that failed loudly, so
    // neither the partial nor the destination may survive to be resumed into
    // permanence.
    await expect(fs.stat(`${destination}.partial`)).rejects.toThrow()
    await expect(fs.stat(destination)).rejects.toThrow()
  })

  it('keeps the partial when the connection drops, then resumes from it', async () => {
    const cut = 20
    const interrupted = await downloadModel(
      { url: 'https://example/model', destination, bytes: BODY.length, sha256: DIGEST },
      { fetch: serving(BODY, { cutAfter: cut }).fetch }
    )
    expect(interrupted.ok).toBe(false)
    expect((await fs.stat(`${destination}.partial`)).size).toBe(cut)

    const resumed = serving(BODY)
    const result = await downloadModel(
      { url: 'https://example/model', destination, bytes: BODY.length, sha256: DIGEST },
      { fetch: resumed.fetch }
    )

    // The whole point: it asked for the remainder, and the hash it verified
    // covers the bytes from the first attempt too.
    expect(resumed.calls).toEqual([`bytes=${cut}-`])
    expect(result.ok).toBe(true)
    expect(result.verify).toBe('verified')
    expect(await fs.readFile(destination)).toEqual(BODY)
  })

  it('starts over when the server ignores the range header', async () => {
    await fs.writeFile(`${destination}.partial`, BODY.subarray(0, 20))
    const server = serving(BODY, { ignoreRange: true })

    const result = await downloadModel(
      { url: 'https://example/model', destination, bytes: BODY.length, sha256: DIGEST },
      { fetch: server.fetch }
    )

    // A 200 to a ranged request means the whole file arrived, so appending it
    // to the partial would corrupt the result — the digest is what proves this
    // took the restart path rather than the append one.
    expect(result.ok).toBe(true)
    expect(result.verify).toBe('verified')
    expect(await fs.readFile(destination)).toEqual(BODY)
  })

  it('starts over when the partial is longer than the file it claims to be', async () => {
    await fs.writeFile(`${destination}.partial`, Buffer.concat([BODY, BODY]))
    const server = serving(BODY)

    const result = await downloadModel(
      { url: 'https://example/model', destination, bytes: BODY.length, sha256: DIGEST },
      { fetch: server.fetch }
    )

    expect(server.calls).toEqual([null])
    expect(result.ok).toBe(true)
    expect(await fs.readFile(destination)).toEqual(BODY)
  })

  it('reports a failing status without leaving a destination file', async () => {
    const failing = (async () =>
      ({ ok: false, status: 404, headers: new Headers() }) as unknown as Response) as unknown as typeof globalThis.fetch

    const result = await downloadModel(
      { url: 'https://example/model', destination, bytes: BODY.length, sha256: DIGEST },
      { fetch: failing }
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('404')
    await expect(fs.stat(destination)).rejects.toThrow()
  })
})
