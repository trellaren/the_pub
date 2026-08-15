import { describe, it, expect } from 'vitest'
import {
  childrenOf,
  flattenManuscript,
  misplacedFrontMatter,
  placeInManuscript,
  reconcile,
  rollUpWords,
  toExportItems,
  totalWords,
  type ManuscriptNode,
  type ResolvedNode
} from './manuscript.js'

/**
 * The binder's structure, tested where it is pure.
 *
 * Everything here is arithmetic over a flat array, which is exactly why the
 * model is a flat array: the ordering, the nesting and the export flattening
 * are all decidable without a DOM, a drag, or a file. `dropTarget.test.ts`
 * covers aiming a drop; this covers what happens once it lands.
 */

function part(id: string, order: number, extra: Partial<ManuscriptNode> = {}): ManuscriptNode {
  return { id, kind: 'part', parentId: null, order, title: id, role: 'body', docId: null, path: '', ...extra }
}

function doc(id: string, parentId: string | null, order: number, extra: Partial<ManuscriptNode> = {}): ManuscriptNode {
  return {
    id,
    kind: 'document',
    parentId,
    order,
    title: id,
    role: 'body',
    docId: `doc-${id}`,
    path: `${id}.pubdoc`,
    ...extra
  }
}

describe('childrenOf', () => {
  it('returns one parent’s children in order', () => {
    const nodes = [doc('b', 'p1', 2), doc('a', 'p1', 1), doc('c', null, 1), part('p1', 0)]
    expect(childrenOf(nodes, 'p1').map((node) => node.id)).toEqual(['a', 'b'])
    expect(childrenOf(nodes, null).map((node) => node.id)).toEqual(['p1', 'c'])
  })

  /* Equal keys are reachable — two drops can land on the same fraction — and an
   * unstable sort would make rows swap places on re-render for no reason. */
  it('breaks ties by id so the order never flickers', () => {
    const nodes = [doc('z', null, 1), doc('a', null, 1)]
    expect(childrenOf(nodes, null).map((node) => node.id)).toEqual(['a', 'z'])
  })
})

describe('placeInManuscript', () => {
  const nodes = [doc('a', null, 0), doc('b', null, 1), doc('c', null, 2)]

  it('places at the front, the middle and the end', () => {
    expect(placeInManuscript(nodes, 'new', null, 0).order).toBeLessThan(0)
    const middle = placeInManuscript(nodes, 'new', null, 1).order
    expect(middle).toBeGreaterThan(0)
    expect(middle).toBeLessThan(1)
    expect(placeInManuscript(nodes, 'new', null, 3).order).toBeGreaterThan(2)
  })

  it('clamps an index past the end rather than producing nonsense', () => {
    expect(placeInManuscript(nodes, 'new', null, 99).order).toBeGreaterThan(2)
    expect(placeInManuscript(nodes, 'new', null, -5).order).toBeLessThan(0)
  })

  /*
   * The one that matters.
   *
   * Indices count the destination as it looks *without* the moving node. If the
   * node counted itself, dragging a row down by one position would compute its
   * own current slot and write a key it already has — the drag would appear to
   * do nothing, which is the classic bug in this kind of interface and is
   * invisible in any test that only drags a *new* item in.
   */
  it('excludes the moving node from its own neighbours', () => {
    // Move 'a' (currently first) to index 1, meaning "between b and c".
    const placed = placeInManuscript(nodes, 'a', null, 1)
    expect(placed.order).toBeGreaterThan(1)
    expect(placed.order).toBeLessThan(2)
  })

  it('moves a node into another parent', () => {
    const tree = [part('p1', 0), part('p2', 1), doc('a', 'p1', 0), doc('b', 'p2', 0)]
    const placed = placeInManuscript(tree, 'a', 'p2', 1)
    expect(placed.parentId).toBe('p2')
    expect(placed.order).toBeGreaterThan(0)
  })

  it('places into an empty parent', () => {
    const tree = [part('p1', 0), doc('a', null, 0)]
    expect(placeInManuscript(tree, 'a', 'p1', 0)).toEqual({ parentId: 'p1', order: 0 })
  })
})

describe('flattenManuscript', () => {
  const nodes = [part('p1', 0), doc('a', 'p1', 0), doc('b', 'p1', 1), doc('loose', null, 1)]

  it('walks depth-first with a depth per row', () => {
    expect(flattenManuscript(nodes).map((row) => [row.node.id, row.depth])).toEqual([
      ['p1', 0],
      ['a', 1],
      ['b', 1],
      ['loose', 0]
    ])
  })

  it('hides the children of a collapsed part', () => {
    expect(flattenManuscript(nodes, new Set(['p1'])).map((row) => row.node.id)).toEqual(['p1', 'loose'])
  })

  it('numbers each row among its own siblings, not globally', () => {
    const rows = flattenManuscript(nodes)
    expect(rows.map((row) => row.siblingIndex)).toEqual([0, 0, 1, 1])
  })
})

describe('rollUpWords', () => {
  const nodes = [part('p1', 0), doc('a', 'p1', 0), doc('b', 'p1', 1), doc('loose', null, 1)]
  const words = new Map([
    ['a', 1000],
    ['b', 500],
    ['loose', 25]
  ])

  it('gives a part its subtree’s total and a document its own', () => {
    const totals = rollUpWords(nodes, words)
    expect(totals.get('p1')).toBe(1500)
    expect(totals.get('a')).toBe(1000)
    expect(totals.get('loose')).toBe(25)
  })

  it('reports zero for a part with nothing in it, rather than nothing at all', () => {
    expect(rollUpWords([part('empty', 0)], new Map()).get('empty')).toBe(0)
  })

  /* An unindexed or missing document contributes nothing, so the total is an
   * understatement rather than a fiction. */
  it('treats an uncounted document as zero', () => {
    expect(totalWords(nodes, new Map([['a', 1000]]))).toBe(1000)
  })

  it('totals the whole book', () => {
    expect(totalWords(nodes, words)).toBe(1525)
  })
})

describe('misplacedFrontMatter', () => {
  it('says nothing when there is no front matter', () => {
    expect(misplacedFrontMatter([doc('a', null, 0), part('p1', 1)])).toEqual([])
  })

  it('says nothing when every front part leads', () => {
    const nodes = [part('fm', 0, { title: 'Front Matter', role: 'front' }), part('p1', 1, { title: 'Part One' })]
    expect(misplacedFrontMatter(nodes)).toEqual([])
  })

  /* The case toExportItems refuses to fix: a front part dragged below a
   * chapter would export a title page mid-book if silently reordered. */
  it('names a front part left after a chapter', () => {
    const nodes = [
      doc('chapter-one', null, 0),
      part('fm', 1, { title: 'Dedication', role: 'front' })
    ]
    expect(misplacedFrontMatter(nodes)).toEqual(['Dedication'])
  })

  it('names every misplaced part, in book order', () => {
    const nodes = [
      part('title', 0, { title: 'Title Page', role: 'front' }),
      doc('chapter-one', null, 1),
      part('dedication', 2, { title: 'Dedication', role: 'front' }),
      part('epigraph', 3, { title: 'Epigraph', role: 'front' })
    ]
    expect(misplacedFrontMatter(nodes)).toEqual(['Dedication', 'Epigraph'])
  })

  it('does not flag a body or back part', () => {
    const nodes = [doc('chapter-one', null, 0), part('appendix', 1, { title: 'Appendix', role: 'back' })]
    expect(misplacedFrontMatter(nodes)).toEqual([])
  })
})

describe('toExportItems', () => {
  function resolved(node: ManuscriptNode, extra: Partial<ResolvedNode> = {}): ResolvedNode {
    return { ...node, resolvedPath: node.kind === 'document' ? node.path : null, words: 0, missing: false, ...extra }
  }

  it('emits a heading for a body part, then its chapters', () => {
    const nodes = [part('p1', 0, { title: 'Part One' }), doc('a', 'p1', 0), doc('b', 'p1', 1)].map((node) =>
      resolved(node)
    )
    expect(toExportItems(nodes).items).toEqual([
      { kind: 'heading', title: 'Part One', level: 1 },
      { kind: 'document', path: 'a.pubdoc' },
      { kind: 'document', path: 'b.pubdoc' }
    ])
  })

  /*
   * Front matter carries no heading. A book opens with a title page and a
   * dedication; it does not open with a page reading "Front Matter".
   */
  it('emits no heading for a front-matter part', () => {
    const nodes = [part('fm', 0, { title: 'Front Matter', role: 'front' }), doc('title-page', 'fm', 0)].map((node) =>
      resolved(node)
    )
    expect(toExportItems(nodes).items).toEqual([{ kind: 'document', path: 'title-page.pubdoc' }])
  })

  /* Role decides rendering, never order — so a front part dragged below a
   * chapter really does export in the middle, and the panel warns instead. */
  it('does not reorder a front part that was left in the middle', () => {
    const nodes = [
      doc('chapter-one', null, 0),
      part('fm', 1, { title: 'Front Matter', role: 'front' }),
      doc('dedication', 'fm', 0)
    ].map((node) => resolved(node))
    expect(toExportItems(nodes).items.map((item) => ('path' in item ? item.path : item.title))).toEqual([
      'chapter-one.pubdoc',
      'dedication.pubdoc'
    ])
  })

  it('interleaves root-level documents with parts in order', () => {
    const nodes = [
      doc('prologue', null, 0),
      part('p1', 1, { title: 'Part One' }),
      doc('one', 'p1', 0),
      doc('epilogue', null, 2)
    ].map((node) => resolved(node))
    expect(toExportItems(nodes).items).toEqual([
      { kind: 'document', path: 'prologue.pubdoc' },
      { kind: 'heading', title: 'Part One', level: 1 },
      { kind: 'document', path: 'one.pubdoc' },
      { kind: 'document', path: 'epilogue.pubdoc' }
    ])
  })

  it('skips an empty part rather than titling nothing', () => {
    const nodes = [part('p1', 0, { title: 'Part One' })].map((node) => resolved(node))
    expect(toExportItems(nodes).items).toEqual([])
  })

  /*
   * A document that could not be found is named, not silently dropped. The
   * caller reports it beside the success, because a book exported with a
   * chapter quietly missing is the worst outcome this feature has.
   */
  it('names what it could not export', () => {
    const nodes = [
      resolved(doc('a', null, 0)),
      resolved(doc('gone', null, 1, { title: 'Chapter Four' }), { resolvedPath: null, missing: true })
    ]
    const result = toExportItems(nodes)
    expect(result.items).toEqual([{ kind: 'document', path: 'a.pubdoc' }])
    expect(result.skipped).toEqual(['Chapter Four'])
  })
})

describe('reconcile', () => {
  /*
   * Every repair moves a node to the root; none removes one. A malformed
   * container is not a reason to lose somebody's chapter.
   */
  it('reparents a node whose parent does not exist', () => {
    const repaired = reconcile([doc('orphan', 'nowhere', 0)])
    expect(repaired[0]!.parentId).toBeNull()
    expect(repaired).toHaveLength(1)
  })

  it('reparents a document parented to another document', () => {
    const repaired = reconcile([doc('a', null, 0), doc('b', 'a', 0)])
    expect(repaired.find((node) => node.id === 'b')!.parentId).toBeNull()
  })

  it('lifts a part out of another part, since this version has two levels', () => {
    const repaired = reconcile([part('outer', 0), part('inner', 0, { parentId: 'outer' })])
    expect(repaired.find((node) => node.id === 'inner')!.parentId).toBeNull()
  })

  it('breaks a node parented to itself', () => {
    const repaired = reconcile([part('self', 0, { parentId: 'self' })])
    expect(repaired[0]!.parentId).toBeNull()
  })

  it('leaves a sound structure exactly as it was', () => {
    const nodes = [part('p1', 0), doc('a', 'p1', 0), doc('loose', null, 1)]
    expect(reconcile(nodes)).toEqual(nodes)
  })
})
