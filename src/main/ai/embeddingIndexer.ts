import type { SearchIndexService } from '../services/searchIndexService.js'
import type { RetrievalStatus } from '../../shared/model/retrieval.js'
import { Embedder, EMBED_BATCH } from './embedder.js'

/**
 * Filling the retrieval index, a batch at a time.
 *
 * Incremental off the same block rows the full-text index already maintains: a
 * block that has a current vector is not embedded again, so re-saving a chapter
 * costs the paragraphs that changed and nothing else.
 *
 * What this deliberately does not do is start a model. `resolve` is handed a
 * flag saying whether the caller was a person pressing a button or the app
 * noticing an opportunity, and only the former is allowed to load several
 * gigabytes of weights. Background work that spins up an engine is how a laptop
 * gets hot for reasons its owner cannot account for.
 */

/** Enough of a paragraph to characterise it; most embedding models stop well before this. */
export const MAX_EMBED_CHARS = 2000

export interface EmbedderResolution {
  embedder: Embedder | null
  /** Why not, when there is no embedder. Shown to the writer verbatim. */
  unavailable: string
}

export interface EmbeddingIndexerDeps {
  index: SearchIndexService
  /** @param allowStart the caller asked for this directly, so loading a model is fair. */
  resolve: (allowStart: boolean) => Promise<EmbedderResolution>
  onProgress: (status: RetrievalStatus) => void
}

export class EmbeddingIndexer {
  private building = false
  private controller: AbortController | null = null
  private lastError = ''
  private lastUnavailable = ''

  constructor(private readonly deps: EmbeddingIndexerDeps) {}

  status(): RetrievalStatus {
    const coverage = this.deps.index.embeddingCoverage()
    return {
      ...coverage,
      building: this.building,
      unavailable: this.lastUnavailable,
      error: this.lastError
    }
  }

  cancel(): void {
    this.controller?.abort()
  }

  /**
   * Bring the index up to date.
   *
   * Returns the status it finished on rather than throwing: a build that ran
   * out of network halfway is not an exception to be caught somewhere, it is a
   * partially-built index with a message attached, and that is exactly what the
   * panel needs to show.
   */
  async build(allowStart: boolean): Promise<RetrievalStatus> {
    if (this.building) return this.status()

    // Claimed before the first await, not after it. Resolving an embedder can
    // mean waiting for a model to load, and a guard on the far side of that
    // wait lets two presses of the button run two loops over the same pending
    // list — embedding every block twice.
    this.building = true
    this.lastError = ''
    this.controller = new AbortController()
    this.emit()

    try {
      const { embedder, unavailable } = await this.deps.resolve(allowStart)
      this.lastUnavailable = unavailable
      // Not an early return: the status a caller gets must be the one `finally`
      // leaves behind, or it reports a build still in progress that has already
      // stopped.
      for (; embedder; ) {
        if (this.controller.signal.aborted) break
        const pending = this.deps.index.pendingEmbeddings(EMBED_BATCH)
        if (pending.length === 0) break

        const vectors = await embedder.embed(
          pending.map((block) => block.text.slice(0, MAX_EMBED_CHARS)),
          this.controller.signal
        )
        // Written whole or not at all: the batch is aligned by position, and a
        // half-written one would attach vectors to the wrong paragraphs.
        for (const [position, block] of pending.entries()) {
          this.deps.index.writeEmbedding(block.docId, block.blockIndex, block.text, vectors[position]!)
        }
        this.emit()
      }
    } catch (error) {
      // A cancel arrives here as an abort error. That is a person changing their
      // mind, not a failure, and reporting it as one would be a lie.
      this.lastError = this.controller.signal.aborted
        ? ''
        : error instanceof Error
          ? error.message
          : String(error)
    } finally {
      this.building = false
      this.controller = null
      this.emit()
    }

    return this.status()
  }

  private emit(): void {
    this.deps.onProgress(this.status())
  }
}
