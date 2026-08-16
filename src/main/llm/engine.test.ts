import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { LlmEngine } from './engine.js'

let dir: string
let binaryDir: string
let modelPath: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-engine-'))
  binaryDir = path.join(dir, 'bin')
  await fs.mkdir(binaryDir)
  await fs.writeFile(path.join(binaryDir, binaryName()), '#!/bin/sh\n')
  modelPath = path.join(dir, 'model.gguf')
  await fs.writeFile(modelPath, 'gguf')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function binaryName(): string {
  return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
}

/** A child process that never really starts anything. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null
  stderr = new EventEmitter()
  killed: string[] = []
  kill(signal?: string): boolean {
    this.killed.push(signal ?? 'SIGTERM')
    // A real child exits asynchronously after a signal; mirroring that is what
    // makes `stop()`'s wait meaningful in the test rather than trivially true.
    queueMicrotask(() => {
      this.exitCode = 0
      this.emit('exit', 0)
    })
    return true
  }
}

interface Harness {
  engine: LlmEngine
  children: FakeChild[]
  args: string[][]
  setHealthy: (healthy: boolean) => void
}

function harness(options: { idleMs?: number; startTimeoutMs?: number } = {}): Harness {
  const children: FakeChild[] = []
  const args: string[][] = []
  let healthy = true

  const engine = new LlmEngine({
    binaryDir,
    idleMs: options.idleMs ?? 0,
    startTimeoutMs: options.startTimeoutMs ?? 2000,
    spawn: ((_binary: string, argv: string[]) => {
      args.push(argv)
      const child = new FakeChild()
      children.push(child)
      return child as unknown as ChildProcess
    }) as never,
    fetch: (async () =>
      healthy
        ? ({ ok: true } as Response)
        : Promise.reject(new Error('not listening'))) as unknown as typeof globalThis.fetch
  })

  return { engine, children, args, setHealthy: (value) => (healthy = value) }
}

const request = { modelPath: '', modelId: 'bonsai-9b', contextLength: 4096 }

describe('LlmEngine', () => {
  it('starts a model and reports the loopback URL it is reachable on', async () => {
    const { engine, args } = harness()
    const url = await engine.ensure({ ...request, modelPath })

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(engine.status()).toMatchObject({ state: 'running', model: 'bonsai-9b' })
    // Bound to loopback and told not to serve its own browser UI: nothing but
    // this process should be able to reach the model.
    expect(args[0]).toContain('127.0.0.1')
    expect(args[0]).toContain('--no-webui')
    expect(args[0]).toContain(modelPath)
    await engine.stop()
  })

  it('reuses the running process when the same model is asked for again', async () => {
    const { engine, children } = harness()
    const first = await engine.ensure({ ...request, modelPath })
    const second = await engine.ensure({ ...request, modelPath })

    expect(second).toBe(first)
    expect(children).toHaveLength(1)
    await engine.stop()
  })

  it('shares one spawn between concurrent requests rather than racing them', async () => {
    const { engine, children } = harness()
    const [a, b] = await Promise.all([
      engine.ensure({ ...request, modelPath }),
      engine.ensure({ ...request, modelPath })
    ])

    expect(a).toBe(b)
    expect(children).toHaveLength(1)
    await engine.stop()
  })

  it('stops the running model before starting a different one', async () => {
    const { engine, children } = harness()
    await engine.ensure({ ...request, modelPath })
    await engine.ensure({ ...request, modelPath, modelId: 'bonsai-4b' })

    // One model at a time: memory is the entire constraint, so the first must
    // be gone rather than left running beside the second.
    expect(children).toHaveLength(2)
    expect(children[0]!.killed.length).toBeGreaterThan(0)
    expect(engine.status().model).toBe('bonsai-4b')
    await engine.stop()
  })

  it('surfaces what the runtime said when the model exits during startup', async () => {
    const { engine, children, setHealthy } = harness({ startTimeoutMs: 5000 })
    setHealthy(false)
    const pending = engine.ensure({ ...request, modelPath })

    // Let `start` reach its readiness loop before the child gives up, which is
    // the ordering a model that cannot load actually produces.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const child = children[0]!
    child.stderr.emit('data', Buffer.from('error: unknown model architecture\n'))
    child.emit('exit', 1)

    expect(await pending).toBeNull()
    expect(engine.status().state).toBe('error')
    // The last line of stderr is the difference between "it did not start" and
    // a message worth acting on.
    expect(engine.status().message).toContain('unknown model architecture')
  })

  it('refuses a model file that is not there', async () => {
    const { engine, children } = harness()
    const url = await engine.ensure({ ...request, modelPath: path.join(dir, 'missing.gguf') })

    expect(url).toBeNull()
    expect(children).toHaveLength(0)
    expect(engine.status().message).toContain('not downloaded')
  })

  it('reports no runtime when no binary shipped for this platform', async () => {
    const engine = new LlmEngine({ binaryDir: path.join(dir, 'nowhere') })
    expect(engine.available()).toBe(false)
    expect(await engine.ensure({ ...request, modelPath })).toBeNull()
    expect(engine.status().message).toContain('runtime')
  })

  it('unloads after the idle interval, and a generation keeps it alive', async () => {
    const { engine, children } = harness({ idleMs: 40 })
    await engine.ensure({ ...request, modelPath })

    // Streaming a long reply must not be mistaken for an idle app.
    await new Promise((resolve) => setTimeout(resolve, 25))
    engine.keepAlive()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(engine.status().state).toBe('running')

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(engine.status().state).toBe('stopped')
    expect(children[0]!.killed.length).toBeGreaterThan(0)
  })

  it('gives up when the model never becomes ready', async () => {
    const { engine, setHealthy } = harness({ startTimeoutMs: 120 })
    setHealthy(false)
    const url = await engine.ensure({ ...request, modelPath })

    expect(url).toBeNull()
    expect(engine.status().state).toBe('error')
    expect(engine.status().message).toContain('did not start in time')
  })
})
