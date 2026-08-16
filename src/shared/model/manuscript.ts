import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'
import { keyForIndex } from './ordering.js'

/**
 * The book, as opposed to the folder.
 *
 * A project is a folder of documents; a manuscript is an *ordered* subset of
 * them with a shape — front matter, parts, chapters. Those are different
 * things, and conflating them is why this does not live in the file tree: order
 * is not a property a filesystem has, and expressing it there would mean either
 * numbering filenames or showing a tree that sorts differently from the folder
 * it claims to show.
 *
 * Being outside the manuscript is normal, not an error. Notes, outlines and
 * scratch files stay exactly as usable as they were; they are simply not part
 * of the book.
 */

/**
 * How a part is rendered when the book is compiled.
 *
 * Deliberately *not* a sort key. The author decides where front matter sits by
 * dragging it there; the role only decides whether the part contributes a title
 * page to the exported file. A role that also reordered would make a drag a
 * suggestion rather than an instruction, which is the one thing a binder must
 * never be.
 */
export const partRoles = ['front', 'body', 'back'] as const
export const partRoleSchema = z.enum(partRoles)
export type PartRole = z.infer<typeof partRoleSchema>

/**
 * One node of the binder.
 *
 * Flat, with a `parentId`, rather than nested `children` — for the same reason
 * `Beat` carries a `columnId` rather than the board holding arrays. A move then
 * rewrites one record instead of splicing two arrays, the fractional key stays
 * scoped to a single set of siblings, and there is no recursive schema to parse.
 * It represents exactly the same tree.
 */
export const manuscriptNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(['part', 'document']),
  /** Null for a top-level node. A part's parent is always null in this version. */
  parentId: z.string().nullable().default(null),
  /** Fractional position *among its siblings*. See `keyBetween`. */
  order: z.number().default(0),
  /**
   * A part's name. For a document, the last title seen — a hint, never the
   * authority, and what lets a document that has gone missing still be named.
   */
  title: z.string().default(''),
  /** Parts only. Ignored on a document node. */
  role: partRoleSchema.default('body'),
  /**
   * Documents only: the id inside the `.pubdoc`, which survives a rename.
   *
   * The identity, deliberately, rather than the path. A chapter renamed in
   * Finder or moved on a server is then a non-event, because the index tracks
   * the file to its new path and this still names it.
   */
  docId: z.string().nullable().default(null),
  /** Documents only. Last known path — a hint for a cold index, not a key. */
  path: z.string().default('')
})
export type ManuscriptNode = z.infer<typeof manuscriptNodeSchema>

export const manuscriptFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.manuscript),
  nodes: z.array(manuscriptNodeSchema).default(() => [])
})
export type ManuscriptFile = z.infer<typeof manuscriptFileSchema>

export const EMPTY_MANUSCRIPT: ManuscriptFile = { formatVersion: FORMAT_VERSIONS.manuscript, nodes: [] }

/** A node as a view needs it: resolved against the index, and counted. */
export const resolvedNodeSchema = manuscriptNodeSchema.extend({
  resolvedPath: z.string().nullable().default(null),
  /** This node's own words for a document; the subtree's total for a part. */
  words: z.number().int().default(0),
  /**
   * The document this node names is nowhere on disk.
   *
   * Deliberately not simply `resolvedPath === null`: while the first index pass
   * is still running nothing resolves at all, and every row would claim to be
   * lost. See `resolving` on the view.
   */
  missing: z.boolean().default(false)
})
export type ResolvedNode = z.infer<typeof resolvedNodeSchema>

export const manuscriptViewSchema = z.object({
  nodes: z.array(resolvedNodeSchema).default(() => []),
  /** The index is still catching up: an unresolved row is unknown, not lost. */
  resolving: z.boolean().default(false)
})
export type ManuscriptView = z.infer<typeof manuscriptViewSchema>

export function isPart(node: Pick<ManuscriptNode, 'kind'>): boolean {
  return node.kind === 'part'
}

export function isDocument(node: Pick<ManuscriptNode, 'kind'>): boolean {
  return node.kind === 'document'
}

/** Children of one parent, in order; ties broken stably by id. */
export function childrenOf<T extends ManuscriptNode>(nodes: readonly T[], parentId: string | null): T[] {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/**
 * Where a node dropped at `index` of `parentId` belongs.
 *
 * `index` counts positions among the destination's children *as they look
 * without the moving node* — which is what a drop indicator between two rows
 * means. The exclusion is load-bearing: counting the moving node makes dragging
 * a row down by one silently do nothing, which is the single most common bug in
 * this class of interface.
 */
export function placeInManuscript(
  nodes: readonly ManuscriptNode[],
  movingId: string,
  parentId: string | null,
  index: number
): { parentId: string | null; order: number } {
  const others = childrenOf(nodes, parentId).filter((node) => node.id !== movingId)
  return { parentId, order: keyForIndex(others, index) }
}

/** One rendered row of the binder. */
export interface ManuscriptRow {
  node: ManuscriptNode
  depth: 0 | 1
  /** Position among its siblings, which is what the drop maths counts in. */
  siblingIndex: number
}

/**
 * The rows to render: a depth-first walk honouring collapse.
 *
 * An expanded part with no children yields no row of its own beyond its header,
 * and the panel supplies a placeholder for it — see `dropTarget.ts`. Keeping
 * that in the panel rather than here means this function describes the data and
 * nothing about how a drop is aimed.
 */
export function flattenManuscript(
  nodes: readonly ManuscriptNode[],
  collapsed: ReadonlySet<string> = new Set()
): ManuscriptRow[] {
  const rows: ManuscriptRow[] = []
  childrenOf(nodes, null).forEach((node, siblingIndex) => {
    rows.push({ node, depth: 0, siblingIndex })
    if (isPart(node) && !collapsed.has(node.id)) {
      childrenOf(nodes, node.id).forEach((child, childIndex) => {
        rows.push({ node: child, depth: 1, siblingIndex: childIndex })
      })
    }
  })
  return rows
}

/**
 * Words per node, with each part carrying its subtree's total.
 *
 * `words` maps a document node's id to its count. Anything absent contributes
 * zero, which is what an unindexed or missing document should do — the total is
 * then an understatement rather than a fiction.
 */
export function rollUpWords(
  nodes: readonly ManuscriptNode[],
  words: ReadonlyMap<string, number>
): Map<string, number> {
  const totals = new Map<string, number>()
  for (const node of nodes) {
    if (!isDocument(node)) continue
    const own = words.get(node.id) ?? 0
    totals.set(node.id, own)
    if (node.parentId) totals.set(node.parentId, (totals.get(node.parentId) ?? 0) + own)
  }
  // A part with no documents still reports a total, rather than nothing.
  for (const node of nodes) if (isPart(node) && !totals.has(node.id)) totals.set(node.id, 0)
  return totals
}

/** The whole book's word count. */
export function totalWords(nodes: readonly ManuscriptNode[], words: ReadonlyMap<string, number>): number {
  return nodes.reduce((sum, node) => (isDocument(node) ? sum + (words.get(node.id) ?? 0) : sum), 0)
}

/**
 * What the exporter consumes: a linear stream of documents and headings.
 *
 * Also the shape `docx:export` and `docx:exportDialog` widen their `items`
 * field with — one schema, so the panel and the IPC boundary cannot drift.
 * `level` is capped at 3 rather than the 1 this version ever emits: the binder
 * is bounded to two levels by construction, but `parentId` already expresses
 * arbitrary depth, and a schema that had to widen later would be a format
 * migration every project would need. This is headroom, not a promise.
 */
export const exportItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), path: z.string() }),
  z.object({ kind: z.literal('heading'), title: z.string(), level: z.number().int().min(1).max(3).default(1) })
])
export type ExportItem = z.infer<typeof exportItemSchema>

/**
 * Flatten the binder into the stream the exporter takes.
 *
 * A `body` or `back` part contributes a heading before its children. A `front`
 * part contributes none — nobody wants a page in their book saying "Front
 * Matter" — so a title page and a dedication export directly, which is the
 * whole of the role mechanism as far as the exporter is concerned.
 *
 * Front matter comes first because the author dragged it there, not because
 * this reorders: a `front` part left below chapter three exports a title page
 * in the middle of the book. Silently moving what someone dragged is the worse
 * failure, so the panel warns and this obeys.
 *
 * Nodes whose documents could not be found are skipped and named, so the
 * caller can say so. Shipping a manuscript with a chapter silently absent is
 * the worst thing this feature could do.
 */
/**
 * Whether a `front` part sits somewhere other than the very start of the book.
 *
 * `toExportItems` never reorders to fix this — see its own comment — so the
 * panel needs a way to say so instead. Titles of the misplaced parts, in book
 * order, for a warning specific enough to act on.
 */
export function misplacedFrontMatter(nodes: readonly ManuscriptNode[]): string[] {
  const root = childrenOf(nodes, null)
  const firstNonFront = root.findIndex((node) => !(isPart(node) && node.role === 'front'))
  if (firstNonFront === -1) return []
  return root
    .slice(firstNonFront)
    .filter((node) => isPart(node) && node.role === 'front')
    .map((node) => node.title || 'Untitled part')
}

export function toExportItems(nodes: readonly ResolvedNode[]): { items: ExportItem[]; skipped: string[] } {
  const items: ExportItem[] = []
  const skipped: string[] = []

  const emitDocument = (node: ResolvedNode): void => {
    if (!node.resolvedPath) {
      skipped.push(node.title || node.path || 'an untitled document')
      return
    }
    items.push({ kind: 'document', path: node.resolvedPath })
  }

  for (const node of childrenOf(nodes, null)) {
    if (isDocument(node)) {
      emitDocument(node)
      continue
    }
    const children = childrenOf(nodes, node.id)
    // An empty body part would otherwise contribute a title page to nothing.
    if (node.role !== 'front' && children.length > 0) {
      items.push({ kind: 'heading', title: node.title, level: 1 })
    }
    for (const child of children) if (isDocument(child)) emitDocument(child)
  }

  return { items, skipped }
}

/**
 * Repair a structure that does not hold together, rather than discarding it.
 *
 * A hand-edited file, a partially-written one, or a future version read by an
 * older build can all produce a node whose parent does not exist, a part nested
 * inside a part, or a document parented to a document. Every one of those is
 * reparented to the root rather than dropped — the same instinct as
 * `BeatService` moving orphaned beats to the first surviving column. Losing a
 * chapter out of someone's book because its container was malformed is not a
 * trade this code gets to make.
 */
export function reconcile(nodes: readonly ManuscriptNode[]): ManuscriptNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return nodes.map((node) => {
    if (node.parentId === null) return node
    const parent = byId.get(node.parentId)
    // A parent that is missing, is not a part, or is the node itself.
    if (!parent || !isPart(parent) || parent.id === node.id) return { ...node, parentId: null }
    // Two levels only in this version: a part never sits inside anything.
    if (isPart(node)) return { ...node, parentId: null }
    return node
  })
}
