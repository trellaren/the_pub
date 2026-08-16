import { CSL } from 'citeproc-plus'
import type { CslItem } from '@shared/model/source.js'

/**
 * One citeproc-js engine instance per CSL style id, kept alive for the life of
 * the renderer.
 *
 * `citeproc-plus`'s own `CSL` object caches the downloaded style and locale
 * chunks, but building an `Engine` from them still costs real time — Chicago's
 * style file alone is large — so a `refreshCitations` call triggered by every
 * source edit would visibly stall typing if it rebuilt the engine each time.
 * The library's own docs note one `CSL` suffices for any number of engines, so
 * this module-level instance is exactly that: one loader, one engine per style
 * actually used in this session.
 *
 * The style and locale catalog ships as gzip chunks (`dist/assets/*.gz`);
 * `electron.vite.config.ts`'s `assetsInclude` is what tells Vite to hand
 * those to the renderer as plain static assets instead of trying to parse
 * them as JavaScript.
 */
const csl = new CSL()

/**
 * The engine's `sys.retrieveItem`, and the item map it reads, live behind one
 * indirection so a cached engine can be pointed at this call's sources without
 * losing the engine itself: closing over `itemsRef.current` rather than the
 * `Map` directly means updating `.current` before use reaches the same
 * closure the already-built engine holds.
 */
interface EngineEntry {
  engine: CiteprocEngine
  itemsRef: { current: Map<string, CslItem> }
}

const engines = new Map<string, Promise<EngineEntry>>()

/** The subset of `citeproc-js`'s `Engine` this module actually drives. */
export interface CiteprocEngine {
  opt: { xclass: 'in-text' | 'note' }
  updateItems(idList: string[]): void
  updateUncitedItems(idList: string[]): void
  setOutputFormat(format: 'html' | 'text' | 'rtf'): void
  rebuildProcessorState(
    citations: CitationCluster[],
    format?: 'html' | 'text' | 'rtf',
    uncitedItemIds?: string[]
  ): Array<[string, number, string]>
  makeBibliography(): [BibliographyMeta, string[]] | false
}

export interface CitationCluster {
  citationID: string
  citationItems: Array<{ id: string; locator?: string; label?: string; 'suppress-author'?: boolean }>
  properties: { noteIndex: number }
}

export interface BibliographyMeta {
  entry_ids: string[][]
}

/**
 * Whether a style renders citations as footnotes (Chicago notes-bibliography)
 * or inline (author-date, APA, MLA) — read off the style itself rather than a
 * hardcoded list of style ids, since it's the ground truth citeproc uses to
 * choose numbering and ibid. behaviour.
 */
export function isNoteStyle(engine: CiteprocEngine): boolean {
  return engine.opt.xclass === 'note'
}

/**
 * The engine for `styleId`, with its item registry pointed at `sources` for
 * this call. `sources` need only include what's cited *right now* — a source
 * removed from the document since the last refresh should stop being citable,
 * and `updateItems` below is what drops it from the engine's registry.
 */
export async function withEngine<T>(
  styleId: string,
  sources: CslItem[],
  run: (engine: CiteprocEngine) => T
): Promise<T> {
  let cached = engines.get(styleId)
  if (!cached) {
    const itemsRef = { current: new Map<string, CslItem>() }
    const sys = { retrieveItem: (id: string) => itemsRef.current.get(String(id)) }
    cached = csl.getEngine(sys, styleId).then((engine) => ({
      engine: engine as unknown as CiteprocEngine,
      itemsRef
    }))
    engines.set(styleId, cached)
  }
  const { engine, itemsRef } = await cached
  itemsRef.current = new Map(sources.map((source) => [source.id, source]))
  engine.updateItems(sources.map((source) => source.id))
  return run(engine)
}
