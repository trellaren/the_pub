import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  childrenOf,
  isPart,
  manuscriptFileSchema,
  manuscriptNodeSchema,
  placeInManuscript,
  reconcile,
  rollUpWords,
  type ManuscriptFile,
  type ManuscriptNode,
  type ManuscriptView,
  type PartRole,
  type ResolvedNode
} from '../../shared/model/manuscript.js'
import { keyBetween } from '../../shared/model/ordering.js'
import { MANUSCRIPT_FILE, PUB_DIR, FORMAT_VERSION } from '../../shared/constants.js'

function emptyFile(): ManuscriptFile {
  return { formatVersion: FORMAT_VERSION, nodes: [] }
}

/**
 * How the manuscript finds out where its documents currently are.
 *
 * Callbacks rather than a `SearchIndexService` reference, following the same
 * reasoning as that service's own `getRoster`: holding the index here would
 * invert the dependency, and a setter would leave a window in which the
 * manuscript resolves against nothing.
 */
export interface DocumentResolver {
  /** Current path for a stable document id, or null if the index has not seen it. */
  resolvePath: (docId: string) => string | null
  /** Word counts by document id, in one query. */
  wordCountsFor: (docIds: readonly string[]) => Map<string, number>
  /** Whether the first index pass is still running. */
  indexing: () => boolean
}

/**
 * The book's structure, persisted to `.thepub/manuscript.json`.
 *
 * Same shape as `BeatService` and for the same reasons: this process is the
 * file's only writer, it never re-reads on a watcher event, and a corrupt file
 * is set aside rather than overwritten.
 *
 * What is different, and deliberate: **reads never write.** `view()` resolves
 * paths and counts words without touching the file, so an author whose network
 * drive is unplugged — or whose index has not finished its first pass — cannot
 * lose the shape of their book to a well-meaning tidy-up. Stale hints are
 * refreshed only by calls that were already writing.
 */
export class ManuscriptService {
  private cache: ManuscriptFile = emptyFile()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly adapter: VfsAdapter,
    private readonly resolver: DocumentResolver
  ) {}

  async load(): Promise<ManuscriptFile> {
    const existing = await this.adapter.stat(MANUSCRIPT_FILE)
    if (!existing) {
      this.cache = emptyFile()
      return this.snapshot()
    }
    try {
      const raw = await this.adapter.readFile(MANUSCRIPT_FILE)
      const parsed = manuscriptFileSchema.parse(JSON.parse(raw.toString('utf8')))
      // Repair rather than trust: a hand-edited or half-written file must not
      // be able to hide a chapter behind a parent that does not exist.
      this.cache = { ...parsed, nodes: reconcile(parsed.nodes) }
    } catch {
      await this.adapter
        .rename(MANUSCRIPT_FILE, `${MANUSCRIPT_FILE}.corrupt-${Date.now()}`)
        .catch(() => {})
      this.cache = emptyFile()
    }
    return this.snapshot()
  }

  snapshot(): ManuscriptFile {
    return structuredClone(this.cache)
  }

  /**
   * The binder as a view needs it: resolved, counted, and honest about what it
   * could not find.
   *
   * Performs no writes whatsoever — see the class comment.
   */
  view(): ManuscriptView {
    const documents = this.cache.nodes.filter((node) => !isPart(node))
    const docIds = documents.map((node) => node.docId).filter((id): id is string => Boolean(id))
    const counts = this.resolver.wordCountsFor(docIds)
    const resolving = this.resolver.indexing()

    const wordsByNode = new Map<string, number>()
    const resolvedPaths = new Map<string, string | null>()
    for (const node of documents) {
      const path = node.docId ? this.resolver.resolvePath(node.docId) : null
      resolvedPaths.set(node.id, path)
      if (node.docId) wordsByNode.set(node.id, counts.get(node.docId) ?? 0)
    }

    const totals = rollUpWords(this.cache.nodes, wordsByNode)

    const nodes: ResolvedNode[] = this.cache.nodes.map((node) => {
      if (isPart(node)) {
        return { ...node, resolvedPath: null, words: totals.get(node.id) ?? 0, missing: false }
      }
      const resolvedPath = resolvedPaths.get(node.id) ?? null
      return {
        ...node,
        resolvedPath,
        words: totals.get(node.id) ?? 0,
        // Unresolved while the index is still building means "not known yet",
        // not "lost". Without this every row of every project would claim to be
        // missing for the first few seconds after opening.
        missing: resolvedPath === null && !resolving
      }
    })

    return { nodes, resolving }
  }

  async createPart(title: string, role: PartRole = 'body'): Promise<ManuscriptNode> {
    const last = childrenOf(this.cache.nodes, null).at(-1)
    const node = manuscriptNodeSchema.parse({
      id: ulid(),
      kind: 'part',
      parentId: null,
      // A new part lands at the end: a book is assembled forwards.
      order: keyBetween(last?.order ?? null, null),
      title,
      role
    })
    this.cache.nodes = [...this.cache.nodes, node]
    await this.flush()
    return structuredClone(node)
  }

  /**
   * Put documents into the book.
   *
   * Takes the docId and the path together because the caller has just read the
   * file: asking the index would fail for a document created moments ago and
   * not yet indexed, which is exactly when an author is most likely to add one.
   */
  async addDocuments(
    incoming: readonly { docId: string; path: string; title: string }[],
    parentId: string | null = null
  ): Promise<ManuscriptNode[]> {
    const known = new Set(this.cache.nodes.map((node) => node.docId).filter(Boolean))
    const added: ManuscriptNode[] = []
    let last = childrenOf(this.cache.nodes, parentId).at(-1)?.order ?? null

    for (const item of incoming) {
      // A document belongs to the book once. Adding it twice would export it
      // twice and double the word count.
      if (known.has(item.docId)) continue
      const node = manuscriptNodeSchema.parse({
        id: ulid(),
        kind: 'document',
        parentId,
        order: keyBetween(last, null),
        title: item.title,
        docId: item.docId,
        path: item.path
      })
      last = node.order
      known.add(item.docId)
      added.push(node)
    }

    if (added.length > 0) {
      this.cache.nodes = [...this.cache.nodes, ...added]
      await this.flush()
    }
    return structuredClone(added)
  }

  /** Move a node to a position among a parent's children. */
  async move(id: string, parentId: string | null, index: number): Promise<ManuscriptFile> {
    const node = this.cache.nodes.find((candidate) => candidate.id === id)
    if (!node) return this.snapshot()
    // Two levels: a part always sits at the root, whatever a caller asks for.
    const destination = isPart(node) ? null : parentId
    const placed = placeInManuscript(this.cache.nodes, id, destination, index)
    this.cache.nodes = this.cache.nodes.map((candidate) =>
      candidate.id === id ? { ...candidate, ...placed } : candidate
    )
    await this.flush()
    return this.snapshot()
  }

  async rename(id: string, title: string): Promise<ManuscriptFile> {
    return this.patch(id, { title })
  }

  async setRole(id: string, role: PartRole): Promise<ManuscriptFile> {
    return this.patch(id, { role })
  }

  /**
   * Point a node at a different document.
   *
   * The repair for a chapter whose file was deleted or replaced: the author
   * chooses the file, and this takes its id, so the row recovers rather than
   * having to be removed and re-added in the right position.
   */
  async relink(id: string, docId: string, path: string, title: string): Promise<ManuscriptFile> {
    return this.patch(id, { docId, path, title })
  }

  /**
   * Take a node out of the book.
   *
   * Removing a part reparents its children to the root; it never removes them.
   * Silently dropping chapters out of a manuscript because a container was
   * deleted is not a trade this code gets to make — the same instinct as
   * `BeatService.saveColumns` moving orphaned beats rather than losing them.
   */
  async remove(id: string): Promise<ManuscriptFile> {
    const node = this.cache.nodes.find((candidate) => candidate.id === id)
    if (!node) return this.snapshot()

    let nodes = this.cache.nodes.filter((candidate) => candidate.id !== id)
    if (isPart(node)) {
      const orphans = childrenOf(this.cache.nodes, id)
      let last = childrenOf(nodes, null).at(-1)?.order ?? null
      const reparented = new Map(
        orphans.map((child) => {
          last = keyBetween(last, null)
          return [child.id, last]
        })
      )
      nodes = nodes.map((candidate) =>
        reparented.has(candidate.id)
          ? { ...candidate, parentId: null, order: reparented.get(candidate.id)! }
          : candidate
      )
    }

    this.cache.nodes = nodes
    await this.flush()
    return this.snapshot()
  }

  /**
   * Refresh the stored path and title hints for documents that have moved.
   *
   * Called by mutating operations only, never by `view()`. The hints exist so a
   * document can still be named and found when the index is cold; letting a
   * read rewrite them would mean an unplugged network drive could quietly edit
   * the file that describes the book.
   */
  private refreshHints(nodes: ManuscriptNode[]): ManuscriptNode[] {
    return nodes.map((node) => {
      if (isPart(node) || !node.docId) return node
      const path = this.resolver.resolvePath(node.docId)
      return path && path !== node.path ? { ...node, path } : node
    })
  }

  private async patch(id: string, changes: Partial<ManuscriptNode>): Promise<ManuscriptFile> {
    this.cache.nodes = this.cache.nodes.map((node) =>
      node.id === id ? manuscriptNodeSchema.parse({ ...node, ...changes }) : node
    )
    await this.flush()
    return this.snapshot()
  }

  private async flush(): Promise<void> {
    this.cache.nodes = reconcile(this.refreshHints(this.cache.nodes))
    const file: ManuscriptFile = { ...this.cache, formatVersion: FORMAT_VERSION }
    this.queue = this.queue.then(async () => {
      await this.adapter.mkdir(PUB_DIR).catch(() => {})
      await this.adapter.writeFileAtomic(
        MANUSCRIPT_FILE,
        Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
      )
    })
    await this.queue
  }
}
