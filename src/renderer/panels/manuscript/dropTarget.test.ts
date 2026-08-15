import { describe, it, expect } from 'vitest'
import { dropRows, resolveDrop, resolveMove, type DropRow } from './dropTarget.js'
import type { ManuscriptNode } from '../../../shared/model/manuscript.js'

/**
 * Aiming a drop, and the four keyboard moves.
 *
 * The band table from the plan is walked cell by cell, because a band that
 * resolves to the wrong parent is invisible in any test that only checks
 * something moved. The two properties worth stating up front, since most of
 * these assertions are one of them:
 *
 *  - a returned `index` excludes the moving node, and
 *  - a target the node is already at returns null, so nothing is drawn and
 *    nothing is written.
 */

function part(id: string, order: number): ManuscriptNode {
  return { id, kind: 'part', parentId: null, order, title: id, role: 'body', docId: null, path: '' }
}

function doc(id: string, parentId: string | null, order: number): ManuscriptNode {
  return {
    id,
    kind: 'document',
    parentId,
    order,
    title: id,
    role: 'body',
    docId: `doc-${id}`,
    path: `${id}.pubdoc`
  }
}

/** Part One [a, b], Part Two (empty), loose. */
const book: ManuscriptNode[] = [
  part('p1', 0),
  doc('a', 'p1', 0),
  doc('b', 'p1', 1),
  part('p2', 1),
  doc('loose', null, 2)
]

const rows = dropRows(book)

const TOP = 0.1
const MIDDLE = 0.5
const BOTTOM = 0.9

function at(id: string): number {
  return rows.findIndex((row) => row.kind === 'node' && row.node.id === id)
}

describe('dropRows', () => {
  it('gives an expanded empty part a placeholder to aim at', () => {
    expect(rows.map(describeRow)).toEqual(['p1', 'a', 'b', 'p2', 'placeholder:p2', 'loose'])
  })

  it('gives a part with children no placeholder', () => {
    expect(dropRows([part('p1', 0), doc('a', 'p1', 0)]).map(describeRow)).toEqual(['p1', 'a'])
  })

  /* A collapsed empty part shows no placeholder — there is no open space to
   * drop into, and its middle band already means "inside". */
  it('gives a collapsed part no placeholder and hides its children', () => {
    expect(dropRows(book, new Set(['p1', 'p2'])).map(describeRow)).toEqual(['p1', 'p2', 'loose'])
  })
})

function describeRow(row: DropRow): string {
  return row.kind === 'placeholder' ? `placeholder:${row.partId}` : row.node.id
}

describe('the band table — a part row', () => {
  it('top band drops before the part, at the root', () => {
    expect(resolveDrop(book, rows, 'loose', at('p1'), TOP)).toEqual({
      parentId: null,
      index: 0,
      indicator: { kind: 'between', row: 0, depth: 0 }
    })
  })

  it('middle band drops inside the part, at the end', () => {
    expect(resolveDrop(book, rows, 'loose', at('p1'), MIDDLE)).toEqual({
      parentId: 'p1',
      index: 2,
      indicator: { kind: 'inside', partId: 'p1' }
    })
  })

  /* The rule goes below the part's chapters, not under its header: a line
   * tucked between "Part One" and chapter one would read as "inside". */
  it('bottom band drops after the part and below its children', () => {
    expect(resolveDrop(book, rows, 'loose', at('p1'), BOTTOM)).toEqual({
      parentId: null,
      index: 1,
      indicator: { kind: 'between', row: at('p2'), depth: 0 }
    })
  })
})

describe('the band table — a document row', () => {
  it('top band drops before the document, in its own parent', () => {
    expect(resolveDrop(book, rows, 'loose', at('b'), TOP)).toEqual({
      parentId: 'p1',
      index: 1,
      indicator: { kind: 'between', row: at('b'), depth: 1 }
    })
  })

  /*
   * A document has no inside, so its middle band means the same as its bottom
   * band. Collapsing them rather than leaving the middle inert is the point: a
   * 50%-tall dead stripe down the centre of every chapter row is a drop that
   * silently does nothing half the time it is attempted.
   */
  it('middle and bottom bands both drop after the document', () => {
    const after = {
      parentId: 'p1',
      index: 2,
      indicator: { kind: 'between', row: at('b') + 1, depth: 1 }
    }
    expect(resolveDrop(book, rows, 'loose', at('b'), MIDDLE)).toEqual(after)
    expect(resolveDrop(book, rows, 'loose', at('b'), BOTTOM)).toEqual(after)
  })

  /*
   * Dropping after the last chapter of a part draws its rule at the same row a
   * root-level drop before the next part would — the indentation is the only
   * thing telling them apart, which is why the depth is asserted here.
   */
  it('distinguishes after-the-last-chapter from before-the-next-part by depth alone', () => {
    const inside = resolveDrop(book, rows, 'loose', at('b'), BOTTOM)
    const outside = resolveDrop(book, rows, 'loose', at('p2'), TOP)
    expect(inside!.indicator).toEqual({ kind: 'between', row: at('p2'), depth: 1 })
    expect(outside!.indicator).toEqual({ kind: 'between', row: at('p2'), depth: 0 })
    expect(inside!.parentId).toBe('p1')
    expect(outside!.parentId).toBeNull()
  })
})

describe('the band table — a placeholder', () => {
  it('drops inside the empty part whatever band is hit', () => {
    const inside = {
      parentId: 'p2',
      index: 0,
      indicator: { kind: 'inside', partId: 'p2' }
    }
    for (const fraction of [TOP, MIDDLE, BOTTOM]) {
      expect(resolveDrop(book, rows, 'loose', at('p2') + 1, fraction)).toEqual(inside)
    }
  })
})

describe('the trailing region', () => {
  it('means the end of the book, at the root', () => {
    expect(resolveDrop(book, rows, 'a', rows.length, 0.5)).toEqual({
      parentId: null,
      index: 3,
      indicator: { kind: 'between', row: rows.length, depth: 0 }
    })
  })

  it('is a no-op for whatever is already last at the root', () => {
    expect(resolveDrop(book, rows, 'loose', rows.length, 0.5)).toBeNull()
  })
})

describe('suppression', () => {
  it('refuses to put a part inside a part', () => {
    expect(resolveDrop(book, rows, 'p2', at('p1'), MIDDLE)).toBeNull()
  })

  it('refuses to put a part inside an empty part’s placeholder', () => {
    expect(resolveDrop(book, rows, 'p1', at('p2') + 1, MIDDLE)).toBeNull()
  })

  it('offers a dragged part nothing on its own subtree', () => {
    expect(resolveDrop(book, rows, 'p1', at('a'), TOP)).toBeNull()
    expect(resolveDrop(book, rows, 'p1', at('a'), BOTTOM)).toBeNull()
    expect(resolveDrop(book, rows, 'p1', at('b'), MIDDLE)).toBeNull()
  })

  /* Its own row's edges are still legal aims; they just resolve to where it
   * already is, which the no-op rule catches. */
  it('offers a dragged part nothing on its own row', () => {
    expect(resolveDrop(book, rows, 'p1', at('p1'), TOP)).toBeNull()
    expect(resolveDrop(book, rows, 'p1', at('p1'), MIDDLE)).toBeNull()
    expect(resolveDrop(book, rows, 'p1', at('p1'), BOTTOM)).toBeNull()
  })

  it('returns nothing for a node that is not in the book', () => {
    expect(resolveDrop(book, rows, 'ghost', at('p1'), MIDDLE)).toBeNull()
  })
})

describe('no-ops', () => {
  it('refuses a drop immediately before or after the node itself', () => {
    expect(resolveDrop(book, rows, 'a', at('a'), TOP)).toBeNull()
    expect(resolveDrop(book, rows, 'a', at('a'), BOTTOM)).toBeNull()
  })

  it('refuses a drop into the gap the node already occupies', () => {
    // Before 'b' is exactly where 'a' already sits.
    expect(resolveDrop(book, rows, 'a', at('b'), TOP)).toBeNull()
  })

  it('refuses to drop a part’s last chapter at the end of that part', () => {
    expect(resolveDrop(book, rows, 'b', at('p1'), MIDDLE)).toBeNull()
  })
})

/*
 * The whole reason this module exists as its own file.
 *
 * A drop indicator sits between two rows as displayed, with the dragged row
 * still in the list; `placeInManuscript` counts the destination without it. Feed
 * one to the other unconverted and dragging a row down by one computes the slot
 * it is already in — the drag appears to do nothing, and no test that only drags
 * a *new* item in will ever notice.
 */
describe('displayed indices versus excluding indices', () => {
  it('subtracts the moving node when it sits above the target', () => {
    // 'a' is displayed at 0 in p1; dropping after 'b' is displayed index 2.
    expect(resolveDrop(book, rows, 'a', at('b'), BOTTOM)).toMatchObject({ parentId: 'p1', index: 1 })
  })

  it('leaves the index alone when the moving node sits below the target', () => {
    expect(resolveDrop(book, rows, 'b', at('a'), TOP)).toMatchObject({ parentId: 'p1', index: 0 })
  })

  it('leaves the index alone when the moving node is in another parent', () => {
    expect(resolveDrop(book, rows, 'loose', at('a'), TOP)).toMatchObject({ parentId: 'p1', index: 0 })
  })

  it('drops a part’s last chapter to the end of the root without an off-by-one', () => {
    // Root shows [p1, p2, loose]; 'b' lives in p1, so nothing is subtracted.
    expect(resolveDrop(book, rows, 'b', rows.length, 0.5)).toMatchObject({ parentId: null, index: 3 })
  })
})

describe('resolveMove', () => {
  it('moves a chapter up and down among its siblings', () => {
    expect(resolveMove(book, 'b', 'up')).toEqual({ parentId: 'p1', index: 0 })
    expect(resolveMove(book, 'a', 'down')).toEqual({ parentId: 'p1', index: 1 })
  })

  it('stops at the ends rather than escaping its parent', () => {
    expect(resolveMove(book, 'a', 'up')).toBeNull()
    expect(resolveMove(book, 'b', 'down')).toBeNull()
  })

  it('moves a part up and down at the root', () => {
    expect(resolveMove(book, 'p2', 'up')).toEqual({ parentId: null, index: 0 })
    expect(resolveMove(book, 'p1', 'down')).toEqual({ parentId: null, index: 1 })
  })

  it('indents a root document into the part directly above it', () => {
    // loose sits after p2, which is empty.
    expect(resolveMove(book, 'loose', 'indent')).toEqual({ parentId: 'p2', index: 0 })
  })

  it('refuses to indent when what is above is not a part', () => {
    const flat = [doc('one', null, 0), doc('two', null, 1)]
    expect(resolveMove(flat, 'two', 'indent')).toBeNull()
  })

  it('refuses to indent the first row, and refuses to indent a part', () => {
    expect(resolveMove(book, 'p1', 'indent')).toBeNull()
    expect(resolveMove(book, 'p2', 'indent')).toBeNull()
  })

  it('refuses to indent a chapter that is already inside a part', () => {
    expect(resolveMove(book, 'b', 'indent')).toBeNull()
  })

  /* Immediately after the part, so the row visibly steps down one line. Sending
   * it to the end of the book would be a different, unasked-for edit. */
  it('outdents to just after the part it leaves', () => {
    expect(resolveMove(book, 'a', 'outdent')).toEqual({ parentId: null, index: 1 })
  })

  it('refuses to outdent something already at the root', () => {
    expect(resolveMove(book, 'loose', 'outdent')).toBeNull()
    expect(resolveMove(book, 'p1', 'outdent')).toBeNull()
  })

  it('returns nothing for a node that is not in the book', () => {
    expect(resolveMove(book, 'ghost', 'up')).toBeNull()
  })

  /*
   * The four together must reach every position, which is the claim that makes
   * them a real alternative to dragging rather than a courtesy. Walking a
   * chapter out of one part and into the next is the longest such path.
   */
  it('covers moving a chapter from one part into the next', () => {
    expect(resolveMove(book, 'a', 'outdent')).toEqual({ parentId: null, index: 1 })
    // Having landed at the root between p1 and p2, it indents into p2.
    const moved = book.map((node) => (node.id === 'a' ? { ...node, parentId: null, order: 0.5 } : node))
    expect(resolveMove(moved, 'a', 'down')).toEqual({ parentId: null, index: 2 })
    const lowered = moved.map((node) => (node.id === 'a' ? { ...node, order: 1.5 } : node))
    expect(resolveMove(lowered, 'a', 'indent')).toEqual({ parentId: 'p2', index: 0 })
  })
})
