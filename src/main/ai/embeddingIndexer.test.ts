import { describe, it, expect, vi } from 'vitest'
import { EmbeddingIndexer, MAX_EMBED_CHARS } from './embeddingIndexer.js'
import { Embedder } from './embedder.js'
import type { SearchIndexService } from '../services/searchIndexService.js'
import type { RetrievalStatus } from '../../shared/model/retrieval.js'

/**
 * A stand-in for the index, holding blocks in memory.
 *
 * The real one is covered by its own tests against real SQLite; what matters
 * here is the loop's behaviour — batching, staleness, cancellation — which a
 * fake makes visible without a database in the way.
 */
function fakeIndex(texts: string[]): SearchIndexService & { vectors: Map<number, Float32Array> } {
  const vectors = new Map<number, Float32Array>()
  return {
    vectors,
    pendingEmbeddings: (limit: number) =>
      texts
        .map((text, blockIndex) => ({ docId: 'doc', blockIndex, text }))
        .filter((block) => !vectors.has(block.blockIndex))
        .slice(0, limit),
    writeEmbedding: (_docId: string, blockIndex: number, _text: string, vector: Float32Array) => {
      vectors.set(blockIndex, vector)
    },
    embeddingCoverage: () => ({ embedded: vectors.size, total: texts.length })
  } as unknown as SearchIndexService & { vectors: Map<number, Float32Array> }
}

function embedderReturning(
  onBatch: (texts: readonly string[]) => void = () => {}
): Embedder {
  return {
    embed: async (texts: readonly string[]) => {
      onBatch(texts)
      return texts.map(() => new Float32Array([1, 0]))
    }
  } as unknown as Embedder
}

function harness(texts: string[], embedder: Embedder | null, unavailable = '') {
  const index = fakeIndex(texts)
  const progress: RetrievalStatus[] = []
  const resolve = vi.fn(async () => ({ embedder, unavailable }))
  const indexer = new EmbeddingIndexer({
    index,
    resolve,
    onProgress: (status) => progress.push(status)
  })
  return { index, indexer, progress, resolve }
}

describe('EmbeddingIndexer', () => {
  it('embeds every pending block and reports itself complete', async () => {
    const { index, indexer } = harness(['one', 'two', 'three'], embedderReturning())

    const status = await indexer.build(true)
    expect(status).toMatchObject({ embedded: 3, total: 3, building: false, error: '' })
    expect(index.vectors.size).toBe(3)
  })

  it('embeds only what is still pending', async () => {
    const seen: string[][] = []
    const { index, indexer } = harness(
      ['one', 'two'],
      embedderReturning((texts) => seen.push([...texts]))
    )
    index.vectors.set(0, new Float32Array([1, 0]))

    await indexer.build(true)
    // The paragraph that already had a vector is not paid for twice.
    expect(seen).toEqual([['two']])
  })

  it('truncates a very long block rather than refusing it', async () => {
    const seen: string[][] = []
    const { indexer } = harness(
      ['x'.repeat(MAX_EMBED_CHARS + 500)],
      embedderReturning((texts) => seen.push([...texts]))
    )

    await indexer.build(true)
    expect(seen[0]![0]!.length).toBe(MAX_EMBED_CHARS)
  })

  it('reports a provider failure as a partial index rather than throwing', async () => {
    const failing = {
      embed: async () => {
        throw new Error('connection refused')
      }
    } as unknown as Embedder
    const { indexer } = harness(['one'], failing)

    const status = await indexer.build(true)
    expect(status.error).toBe('connection refused')
    expect(status).toMatchObject({ embedded: 0, total: 1, building: false })
  })

  it('says why it cannot build, and does not claim to be building', async () => {
    const { indexer, progress } = harness(['one'], null, 'Anthropic has no embeddings API.')

    const status = await indexer.build(true)
    expect(status.unavailable).toBe('Anthropic has no embeddings API.')
    expect(status.building).toBe(false)
    expect(progress.at(-1)?.unavailable).toBe('Anthropic has no embeddings API.')
  })

  it('records a cancel as a stop, not as an error', async () => {
    const index = fakeIndex(['one', 'two'])
    let indexer: EmbeddingIndexer
    const embedder = {
      embed: async (texts: readonly string[]) => {
        // Cancel mid-flight, the way the button does.
        indexer.cancel()
        return texts.map(() => new Float32Array([1, 0]))
      }
    } as unknown as Embedder

    indexer = new EmbeddingIndexer({ index, resolve: async () => ({ embedder, unavailable: '' }), onProgress: () => {} })
    const status = await indexer.build(true)

    // A person changing their mind is not a failure, and saying so would be a
    // lie the panel would then display.
    expect(status.error).toBe('')
    expect(status.building).toBe(false)
  })

  it('passes on whether the caller may start a model', async () => {
    const { indexer, resolve } = harness(['one'], embedderReturning())

    await indexer.build(false)
    expect(resolve).toHaveBeenCalledWith(false)
    await indexer.build(true)
    expect(resolve).toHaveBeenCalledWith(true)
  })

  it('refuses to run twice at once', async () => {
    const index = fakeIndex(['one'])
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const embedder = {
      embed: async (texts: readonly string[]) => {
        await gate
        return texts.map(() => new Float32Array([1, 0]))
      }
    } as unknown as Embedder
    const indexer = new EmbeddingIndexer({
      index,
      resolve: async () => ({ embedder, unavailable: '' }),
      onProgress: () => {}
    })

    const first = indexer.build(true)
    // A second press while the first is in flight must not double-embed every
    // block, which is what two concurrent loops over the same pending list do.
    const second = await indexer.build(true)
    expect(second.building).toBe(true)
    release()
    await first
    expect(index.vectors.size).toBe(1)
  })
})
