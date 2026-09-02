import type { PrintToPDFOptions } from 'electron'
import type { PageSetup } from '../../shared/model/document.js'
import { pageMargins } from '../../shared/model/document.js'

/** Points per inch, the unit `pageSetupSchema` stores lengths in. */
const POINTS_PER_INCH = 72

function pointsToInches(points: number): number {
  return points / POINTS_PER_INCH
}

/**
 * A `PageSetup` → `webContents.printToPDF`'s options, pure so the mapping is
 * testable without a real `BrowserWindow` — the same split `download.ts` and
 * `engine.ts` (Phase 8) make between option-building and the Electron call
 * itself.
 *
 * `preferCSSPageSize: true` because the printed route sets its own `@page`
 * size to match `setup` exactly (see `printDocument.ts`); without it Chromium
 * scales the page to the nearest standard paper size instead of the project's
 * actual one.
 */
export function buildPdfOptions(setup: PageSetup, headerFooter?: { header?: string; footer?: string }): PrintToPDFOptions {
  const sides = pageMargins(setup)
  const margins = {
    marginType: 'custom' as const,
    top: pointsToInches(sides.top),
    bottom: pointsToInches(sides.bottom),
    left: pointsToInches(sides.left),
    right: pointsToInches(sides.right)
  }
  const width = pointsToInches(setup.orientation === 'landscape' ? setup.height : setup.width)
  const height = pointsToInches(setup.orientation === 'landscape' ? setup.width : setup.height)

  const options: PrintToPDFOptions = {
    landscape: setup.orientation === 'landscape',
    printBackground: true,
    preferCSSPageSize: true,
    pageSize: { width, height },
    margins
  }
  if (headerFooter?.header || headerFooter?.footer) {
    options.displayHeaderFooter = true
    options.headerTemplate = headerFooter.header ?? '<span></span>'
    options.footerTemplate = headerFooter.footer ?? '<span></span>'
  }
  return options
}
