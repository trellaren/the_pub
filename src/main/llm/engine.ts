import { spawn, type ChildProcess } from 'node:child_process'
import fsSync from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import type { EngineState } from '../../shared/model/llm.js'

/**
 * The embedded model, running as a supervised child process.
 *
 * `llama-server` on a loopback port, speaking the OpenAI-compatible dialect
 * `buildRequest` already emits for LM Studio — so to everything above the
 * provider layer an embedded model *is* LM Studio, with a lifecycle this app
 * owns. That is the whole reason this is a child process rather than in-process
 * bindings:
 *
 * - inference is gigabytes of native code under memory pressure, and when it
 *   dies it must take a subprocess with it, not the main process and the
 *   author's unsaved manuscript;
 * - no native module in the app binary means no electron-rebuild across three
 *   platforms forever;
 * - GPU support is llama.cpp's own per-platform builds doing what they already
 *   do, rather than our FFI configuration.
 *
 * One model is loaded at a time. RAM is the reason, and a request naming a
 * different model stops the running one first — surfaced as the same "warming
 * up" state a cold start shows, because to the person waiting it is the same
 * thing.
 */

export interface EngineDeps {
  /** Directory holding `llama-server` for this platform. */
  binaryDir: string
  /** How long to wait for readiness before giving up. */
  startTimeoutMs?: number
  /** Zero disables idle shutdown. */
  idleMs?: number
  spawn?: typeof spawn
  fetch?: typeof globalThis.fetch
}

export interface StartRequest {
  /** Absolute path to a `.gguf`. */
  modelPath: string
  /** What to call it in status — a catalogue id or a file name. */
  modelId: string
  contextLength: number
}

export interface EngineStatus {
  state: EngineState
  model: string
  message: string
}

const READY_POLL_MS = 250

export class LlmEngine {
  private child: ChildProcess | null = null
  private port = 0
  private loaded = ''
  private state: EngineState = 'stopped'
  private message = ''
  private idleTimer: NodeJS.Timeout | null = null
  /** In-flight start, so two concurrent sends share one spawn rather than racing. */
  private starting: Promise<string | null> | null = null

  private idleMs: number

  constructor(private readonly deps: EngineDeps) {
    this.idleMs = deps.idleMs ?? 0
  }

  status(): EngineStatus {
    return { state: this.state, model: this.loaded, message: this.message }
  }

  /**
   * Change the idle timeout while a model is loaded.
   *
   * Applied to the running countdown rather than only to the next start:
   * someone who has just set this to two minutes because their machine is
   * struggling means now, not next time.
   */
  setIdleMs(idleMs: number): void {
    this.idleMs = idleMs
    if (this.child) this.touch()
  }

  /**
   * Where to send right now, without loading anything.
   *
   * Null when nothing is running. This is what lets background work use a model
   * that already happens to be up while never being the reason one starts.
   */
  runningUrl(): string | null {
    return this.state === 'running' && this.child ? `http://127.0.0.1:${this.port}` : null
  }

  /** Whether a runtime shipped for this platform at all. */
  available(): boolean {
    return this.binaryPath() !== null
  }

  private binaryPath(): string | null {
    const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
    const candidate = path.join(this.deps.binaryDir, name)
    return fsSync.existsSync(candidate) ? candidate : null
  }

  /**
   * Ensure a model is running, and return the base URL to send to.
   *
   * Null means it could not be started; `status().message` says why. Callers
   * treat that as an ordinary provider error rather than a special case, which
   * is what keeps the embedded path identical to every other provider above
   * this layer.
   */
  async ensure(request: StartRequest): Promise<string | null> {
    this.touch()

    if (this.state === 'running' && this.loaded === request.modelId && this.child) {
      return `http://127.0.0.1:${this.port}`
    }

    // A different model than the one loaded: stop first. Running two at once is
    // deliberately not offered — the memory is the entire constraint.
    if (this.child) await this.stop()

    if (this.starting) return this.starting
    this.starting = this.start(request).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(request: StartRequest): Promise<string | null> {
    const binary = this.binaryPath()
    if (!binary) {
      this.fail('No embedded model runtime shipped for this platform.')
      return null
    }
    if (!fsSync.existsSync(request.modelPath)) {
      this.fail('That model is not downloaded.')
      return null
    }

    this.state = 'starting'
    this.message = ''
    this.loaded = request.modelId

    let port: number
    try {
      port = await freePort()
    } catch {
      this.fail('Could not find a free port for the embedded model.')
      return null
    }

    const spawnFn = this.deps.spawn ?? spawn
    const child = spawnFn(
      binary,
      [
        '--model', request.modelPath,
        '--host', '127.0.0.1',
        '--port', String(port),
        '--ctx-size', String(request.contextLength),
        // The server ships a browser UI on the same port. Nothing reaches this
        // port but us, and serving it would be a second surface for no gain.
        '--no-webui'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    this.child = child
    this.port = port

    // stderr is where llama.cpp explains a refusal to load — a quantisation the
    // build cannot read, a file that is not a model. Keeping the last of it is
    // the difference between "it did not start" and a message worth acting on.
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2000)
    })

    let exitReason: string | null = null
    child.on('exit', (code) => {
      exitReason =
        code === 0
          ? 'The model stopped.'
          : lastLine(stderrTail) || `The model stopped unexpectedly (exit ${code}).`
      this.child = null
      this.loaded = ''
      // A crash mid-stream surfaces on the in-flight request through the
      // ordinary error path; the engine goes to `error` so the next send
      // retries from scratch. No automatic restart loop: a model that cannot
      // load will not load on the second attempt either, and looping hides it.
      if (code !== 0) {
        this.state = 'error'
        this.message = exitReason
      } else if (this.state === 'running') {
        this.state = 'stopped'
        this.message = ''
      }
    })
    child.on('error', (error) => {
      exitReason = error instanceof Error ? error.message : String(error)
      this.child = null
      this.fail(exitReason)
    })

    const deadline = Date.now() + (this.deps.startTimeoutMs ?? 120_000)
    const doFetch = this.deps.fetch ?? globalThis.fetch
    while (Date.now() < deadline) {
      if (exitReason !== null) {
        this.fail(exitReason)
        return null
      }
      try {
        const response = await doFetch(`http://127.0.0.1:${port}/health`)
        if (response.ok) {
          this.state = 'running'
          this.message = ''
          this.touch()
          return `http://127.0.0.1:${port}`
        }
      } catch {
        // Not listening yet. A 27B takes tens of seconds to load; this is the
        // normal path, not an error.
      }
      await delay(READY_POLL_MS)
    }

    await this.stop()
    this.fail('The model did not start in time.')
    return null
  }

  private fail(message: string): void {
    this.state = 'error'
    this.message = message
    this.loaded = ''
  }

  /**
   * Restart the idle countdown.
   *
   * Gigabytes of memory held by an app the writer has tabbed away from is how
   * The Pub gets blamed for a slow machine.
   */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.idleMs <= 0 || !this.child) return
    this.idleTimer = setTimeout(() => void this.stop(), this.idleMs)
    this.idleTimer.unref?.()
  }

  /** Called as replies stream, so a long generation is not counted as idle. */
  keepAlive(): void {
    if (this.child) this.touch()
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const child = this.child
    this.child = null
    this.loaded = ''
    if (this.state !== 'error') {
      this.state = 'stopped'
      this.message = ''
    }
    if (!child || child.exitCode !== null) return

    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        // A model mid-generation can ignore a polite signal. Nothing here has
        // state worth flushing, so the hard kill is safe and bounded.
        child.kill('SIGKILL')
        resolve()
      }, 3000)
      done.unref?.()
      child.once('exit', () => {
        clearTimeout(done)
        resolve()
      })
      child.kill()
    })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Ask the OS for a port by binding zero, then release it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('No port'))))
    })
  })
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}
