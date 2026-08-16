import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  EMBEDDED_MODELS,
  findVariant,
  memoryGate,
  formatBytes,
  downloadUrl,
  type ModelVariant,
  type VariantStatus
} from '../../shared/model/llm.js'
import { downloadModel, type DownloadResult } from './download.js'

/**
 * Model weights on disk, and what is known about them.
 *
 * Weights live in **userData, never a project folder** — the same rule
 * `AiKeyStore` records for keys, for a related reason: a project is a folder
 * the author syncs, shares and commits, and nobody wants 16 GB of weights in
 * their manuscript's history. One copy here serves every project.
 *
 * Nothing is bundled in the installer. A multi-gigabyte download is the price
 * of this feature and it is paid only by the people who choose it — which is
 * also what makes "AI off" cost zero bytes rather than merely hiding a panel.
 */
export class ModelStore {
  /** Downloads in flight, so a second request adopts the first rather than racing it. */
  private inFlight = new Map<string, { controller: AbortController; promise: Promise<DownloadResult> }>()
  /** Digest verification outcome per variant, remembered from the download that produced the file. */
  private verified = new Set<string>()

  constructor(private readonly dir: string) {}

  private pathFor(variantId: string): string {
    return path.join(this.dir, `${variantId}.gguf`)
  }

  /** The file to load, or null when this variant is not downloaded. */
  resolve(variantId: string): string | null {
    const target = this.pathFor(variantId)
    return fsSync.existsSync(target) ? target : null
  }

  /**
   * Where a sideloaded `.gguf` lives.
   *
   * Returned as-is after an existence check rather than being validated as a
   * model: the engine is the authority on whether a file is loadable, and a
   * shape check here would be a second, weaker opinion that could only ever
   * refuse something that would have worked.
   */
  resolveSideloaded(filePath: string): string | null {
    return fsSync.existsSync(filePath) ? filePath : null
  }

  async status(): Promise<VariantStatus[]> {
    const totalMemory = os.totalmem()
    const statuses: VariantStatus[] = []
    for (const model of EMBEDDED_MODELS) {
      for (const variant of model.variants) {
        statuses.push(await this.statusOf(variant, totalMemory))
      }
    }
    return statuses
  }

  private async statusOf(variant: ModelVariant, totalMemory: number): Promise<VariantStatus> {
    const gate = memoryGate(variant, totalMemory)
    if (this.inFlight.has(variant.id)) {
      return {
        variantId: variant.id,
        state: 'downloading',
        bytesOnDisk: await sizeOf(`${this.pathFor(variant.id)}.partial`),
        verified: false,
        gate
      }
    }
    const bytesOnDisk = await sizeOf(this.pathFor(variant.id))
    if (bytesOnDisk > 0) {
      return {
        variantId: variant.id,
        state: 'ready',
        bytesOnDisk,
        // Unverified is a real state, not a failure: a catalogue entry with no
        // published digest cannot be checked, and saying "verified" would claim
        // a check that never ran.
        verified: this.verified.has(variant.id) || variant.sha256.length > 0,
        gate
      }
    }
    return {
      variantId: variant.id,
      state: 'absent',
      bytesOnDisk: await sizeOf(`${this.pathFor(variant.id)}.partial`),
      verified: false,
      gate
    }
  }

  /**
   * Fetch a variant, resuming any partial transfer.
   *
   * Refuses before a byte moves when the machine is too small or the disk is
   * too full — discovering either at 15.9 of 16 GB is the failure this exists
   * to prevent.
   */
  async download(
    variantId: string,
    onProgress: (received: number, total: number) => void
  ): Promise<DownloadResult> {
    const existing = this.inFlight.get(variantId)
    if (existing) return existing.promise

    const found = findVariant(variantId)
    if (!found) {
      return { ok: false, verify: 'unverified', bytes: 0, error: 'No such model.' }
    }
    const { variant } = found

    const gate = memoryGate(variant, os.totalmem())
    if (gate) return { ok: false, verify: 'unverified', bytes: 0, error: gate }

    await fs.mkdir(this.dir, { recursive: true })
    const alreadyHave = await sizeOf(`${this.pathFor(variantId)}.partial`)
    const space = await freeSpace(this.dir)
    const needed = Math.ceil((variant.bytes - alreadyHave) * 1.05)
    if (space !== null && space < needed) {
      return {
        ok: false,
        verify: 'unverified',
        bytes: 0,
        error: `${formatBytes(needed)} of free space is needed and only ${formatBytes(space)} is available.`
      }
    }

    const controller = new AbortController()
    const promise = downloadModel(
      {
        url: downloadUrl(variant),
        destination: this.pathFor(variantId),
        bytes: variant.bytes,
        sha256: variant.sha256
      },
      { fetch: globalThis.fetch },
      { signal: controller.signal, onProgress }
    ).finally(() => this.inFlight.delete(variantId))

    this.inFlight.set(variantId, { controller, promise })
    const result = await promise
    if (result.ok && result.verify === 'verified') this.verified.add(variantId)
    return result
  }

  cancel(variantId: string): void {
    this.inFlight.get(variantId)?.controller.abort()
  }

  /** Delete a variant's weights, and any half-finished download of them. */
  async remove(variantId: string): Promise<void> {
    this.verified.delete(variantId)
    await fs.rm(this.pathFor(variantId), { force: true })
    await fs.rm(`${this.pathFor(variantId)}.partial`, { force: true })
  }
}

async function sizeOf(target: string): Promise<number> {
  try {
    const stat = await fs.stat(target)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

/**
 * Free bytes on the volume holding `dir`, or null when it cannot be determined.
 *
 * Null rather than zero on failure, and the caller skips the check rather than
 * refusing: a preflight that cannot read the disk must not be the reason a
 * download does not start.
 */
async function freeSpace(dir: string): Promise<number | null> {
  try {
    const stat = await fs.statfs(dir)
    return Number(stat.bavail) * Number(stat.bsize)
  } catch {
    return null
  }
}
