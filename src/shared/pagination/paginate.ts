import type { PmDoc, PmNode, PageSetup } from '../model/document.js'
import { pageMargins } from '../model/document.js'
import type { NamedStyle } from '../model/style.js'
import { resolveStyle } from '../model/style.js'

/**
 * What screen and print both need to know a block's size, without either one
 * owning the other's idea of "how tall is this". The screen supplies a
 * DOM-backed measurer; export/print supplies the same shape via an offscreen
 * measurement pass — the breaks either produces are the same breaks *by
 * construction*, because both call this one function with a `Measurer` of
 * their own, never two separate layout implementations that happen to agree.
 */
export interface Measurer {
  /** Height in points of this block's own content, laid out at `width` points wide. */
  measureBlock(node: PmNode, styleId: string | undefined, width: number): number
  /**
   * Height in points this block's footnotes add to the page's *reserved
   * bottom area* — the space Word carves out of the same page for footnote
   * text, not the next one. Zero for a block with no footnotes.
   */
  measureFootnotes(node: PmNode, width: number): number
}

/** Where a page starts. `page` is 1-based; the array holds one entry per page, including the first. */
export interface PageBreak {
  page: number
  startBlockIndex: number
}

/**
 * Lay a document out into pages, given a page size and a way to measure a
 * block. Pure, and deliberately ignorant of decorations, the DOM, or
 * incremental re-measurement — those are screen concerns (Phase 7 steps 3-4,
 * not built here). This is the one thing both the page view and print/export
 * would call, so the breaks they show and the breaks they print are the same
 * by construction.
 *
 * Block granularity, not line granularity: a block never splits across a
 * page boundary. This is what makes the classic widow/orphan failure — a
 * single stranded line — structurally impossible rather than something to
 * detect and patch: a whole paragraph moves together, so there is never a
 * lone line left behind. `keepWithNext` and `pageBreakBefore` (both already
 * on `paragraphStyleAttrsSchema`) are honoured the same way; a block whose
 * own height already exceeds a full page is placed alone on a fresh page and
 * left to overflow it, rather than triggering a break that can never
 * succeed.
 *
 * Footnotes are the one place a block's visible height is not the whole
 * story: a block's `measureFootnotes` result is added to what it costs the
 * page, modelling the reserved bottom area a footnote actually consumes.
 * That is the classic circularity this function is built to resolve without
 * looping: adding a footnote could in principle push its own reference to
 * the next page, which would remove that footnote's reserve from this page —
 * but since every block's full cost (content *and* footnotes) is computed
 * *before* deciding whether it fits, there is nothing to undo and retry. One
 * forward pass, one measurement per block, always terminates.
 */
export function paginate(doc: PmDoc, styles: NamedStyle[], setup: PageSetup, measure: Measurer): PageBreak[] {
  const blocks = doc.content ?? []
  const margins = pageMargins(setup)
  const contentWidth = setup.width - margins.left - margins.right
  const contentHeight = setup.height - margins.top - margins.bottom

  if (blocks.length === 0) return [{ page: 1, startBlockIndex: 0 }]

  const cost = (node: PmNode, styleId: string | undefined): number =>
    measure.measureBlock(node, styleId, contentWidth) + measure.measureFootnotes(node, contentWidth)

  const breaks: PageBreak[] = [{ page: 1, startBlockIndex: 0 }]
  let page = 1
  let used = 0
  let pageHasContent = false

  for (let index = 0; index < blocks.length; index++) {
    const node = blocks[index]!
    const styleId = typeof node.attrs?.styleId === 'string' ? node.attrs.styleId : undefined
    const resolved = styleId ? resolveStyle(styleId, styles) : null
    const forcedBreak = resolved?.paragraph.pageBreakBefore === true
    const keepWithNext = resolved?.paragraph.keepWithNext === true

    const own = cost(node, styleId)
    // Looking one block ahead is what keeps a `keepWithNext` pair from being
    // split by a break landing between them: what has to fit is not this
    // block alone, but this block plus whatever it insists on staying with.
    let required = own
    if (keepWithNext && index + 1 < blocks.length) {
      const next = blocks[index + 1]!
      const nextStyleId = typeof next.attrs?.styleId === 'string' ? next.attrs.styleId : undefined
      required += cost(next, nextStyleId)
    }

    // Never break onto an already-empty page: a block too tall for any page,
    // or a `pageBreakBefore` on the very first block, must not spawn a
    // pointless leading blank page.
    const needsBreak = pageHasContent && (forcedBreak || used + required > contentHeight)
    if (needsBreak) {
      page += 1
      breaks.push({ page, startBlockIndex: index })
      used = 0
      pageHasContent = false
    }

    used += own
    pageHasContent = true
  }

  return breaks
}
