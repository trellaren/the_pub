import { describe, it, expect } from 'vitest'
import { paginate, type Measurer } from './paginate.js'
import { BUILTIN_STYLES, type NamedStyle } from '../model/style.js'
import type { PmDoc, PmNode, PageSetup } from '../model/document.js'

/** US Letter, 1in margins: 612x792pt page, 468x648pt content area. */
const PAGE: PageSetup = { width: 612, height: 792, margin: 72, orientation: 'portrait', columns: 1 }

/** A block whose height (and, optionally, footnote reserve) is stated directly, not measured from real content — the point being to test `paginate`'s own arithmetic, not a text-layout engine. */
function block(testHeight: number, extra: Record<string, unknown> = {}): PmNode {
  return { type: 'paragraph', attrs: { testHeight, ...extra }, content: [{ type: 'text', text: 'x' }] }
}

function doc(...blocks: PmNode[]): PmDoc {
  return { type: 'doc', content: blocks }
}

const syntheticMeasurer: Measurer = {
  measureBlock: (node) => (node.attrs?.testHeight as number) ?? 0,
  measureFootnotes: (node) => (node.attrs?.testFootnoteHeight as number) ?? 0
}

function styleWith(id: string, paragraph: NamedStyle['paragraph']): NamedStyle {
  return { id, name: id, builtin: false, text: {}, paragraph }
}

describe('paginate', () => {
  it('keeps everything on one page when it all fits', () => {
    const content = doc(block(100), block(100), block(100))
    expect(paginate(content, BUILTIN_STYLES, PAGE, syntheticMeasurer)).toEqual([{ page: 1, startBlockIndex: 0 }])
  })

  it('breaks a page exactly where the next block would overflow it', () => {
    // 648pt of content height: two 300pt blocks fit (600), a third does not.
    const content = doc(block(300), block(300), block(300))
    expect(paginate(content, BUILTIN_STYLES, PAGE, syntheticMeasurer)).toEqual([
      { page: 1, startBlockIndex: 0 },
      { page: 2, startBlockIndex: 2 }
    ])
  })

  it('places a block taller than a page alone, on its own page, rather than looping or refusing', () => {
    const content = doc(block(100), block(2000), block(100))
    expect(paginate(content, BUILTIN_STYLES, PAGE, syntheticMeasurer)).toEqual([
      { page: 1, startBlockIndex: 0 },
      { page: 2, startBlockIndex: 1 },
      { page: 3, startBlockIndex: 2 }
    ])
  })

  it('never spawns a leading blank page for an oversized first block', () => {
    // If the empty-page guard only worked for `pageHasContent` reached via a
    // prior break (not the initial state), this would wrongly report the
    // sole block starting on page 2, behind a blank page 1.
    const content = doc(block(2000))
    expect(paginate(content, BUILTIN_STYLES, PAGE, syntheticMeasurer)).toEqual([{ page: 1, startBlockIndex: 0 }])
  })

  it('respects pageBreakBefore, but not on the very first block', () => {
    const styles = [...BUILTIN_STYLES, styleWith('forced', { pageBreakBefore: true })]
    const content = doc(
      { type: 'paragraph', attrs: { styleId: 'forced', testHeight: 50 }, content: [{ type: 'text', text: 'x' }] },
      block(50),
      { type: 'paragraph', attrs: { styleId: 'forced', testHeight: 50 }, content: [{ type: 'text', text: 'y' }] }
    )
    expect(paginate(content, styles, PAGE, syntheticMeasurer)).toEqual([
      { page: 1, startBlockIndex: 0 },
      { page: 2, startBlockIndex: 2 }
    ])
  })

  it('keeps a keepWithNext block on the same page as the one after it', () => {
    const styles = [...BUILTIN_STYLES, styleWith('heading', { keepWithNext: true })]
    // 500pt used, 148pt left on the page. The heading (50pt) would fit alone,
    // but not together with the 200pt block that must follow it — so both
    // move to page 2 rather than stranding the heading at the bottom of page 1.
    const content = doc(block(500), { type: 'paragraph', attrs: { styleId: 'heading', testHeight: 50 }, content: [] }, block(200))
    expect(paginate(content, styles, PAGE, syntheticMeasurer)).toEqual([
      { page: 1, startBlockIndex: 0 },
      { page: 2, startBlockIndex: 1 }
    ])
  })

  it('never splits a block across a page — the widow/orphan failure a line-level model would need to detect is structurally impossible here', () => {
    // A single block cannot itself appear on two different `startBlockIndex`
    // entries; the only guarantee to check is that every break lands on a
    // whole block boundary, which the type system already enforces (`number`,
    // not `{ blockIndex, offset }`) — this test exists to say so explicitly.
    const content = doc(block(400), block(400))
    const breaks = paginate(content, BUILTIN_STYLES, PAGE, syntheticMeasurer)
    expect(breaks.every((entry) => Number.isInteger(entry.startBlockIndex))).toBe(true)
  })

  it("a block's own footnotes grow the page's reserved space, and can push the block itself onward — without looping", () => {
    // 600pt of ordinary content leaves 48pt on the page. The next block is
    // only 30pt of visible text, but carries 40pt of footnote content — its
    // true cost (70pt) is what has to fit, and does not, so it moves onward.
    const content = doc(block(600), block(30, { testFootnoteHeight: 40 }))
    expect(paginate(content, BUILTIN_STYLES, PAGE, syntheticMeasurer)).toEqual([
      { page: 1, startBlockIndex: 0 },
      { page: 2, startBlockIndex: 1 }
    ])
  })

  it('a footnote small enough to fit stays with its reference', () => {
    const content = doc(block(600), block(30, { testFootnoteHeight: 10 }))
    expect(paginate(content, BUILTIN_STYLES, PAGE, syntheticMeasurer)).toEqual([{ page: 1, startBlockIndex: 0 }])
  })

  it('returns a single empty page for a document with no blocks', () => {
    expect(paginate(doc(), BUILTIN_STYLES, PAGE, syntheticMeasurer)).toEqual([{ page: 1, startBlockIndex: 0 }])
  })
})
