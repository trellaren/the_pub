import type { PrintToPDFOptions, WebContentsPrintOptions } from 'electron'
import type { PageSetup } from '../../shared/model/document.js'
import { pageMargins } from '../../shared/model/document.js'

/** Points per inch, the unit `pageSetupSchema` stores lengths in. */
const POINTS_PER_INCH = 72

const MICRONS_PER_INCH = 25400
/** CSS pixels per inch — what `webContents.print`'s margins are measured in. */
const PIXELS_PER_INCH = 96

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

/**
 * The same page as `buildPdfOptions`, in the units `webContents.print`
 * expects instead (microns for the page, pixels for margins), so what prints
 * and what exports as PDF are laid out alike. `print` takes plain-text
 * header/footer strings rather than templates, hence `header` here is text.
 */
export function buildPrintOptions(
  setup: PageSetup,
  headerFooter?: { header?: string; footer?: string }
): WebContentsPrintOptions {
  const pdf = buildPdfOptions(setup)
  const pageSize = pdf.pageSize as { width: number; height: number }
  const margins = pdf.margins!
  const toPixels = (inches: number | undefined): number => Math.round((inches ?? 0) * PIXELS_PER_INCH)
  const options: WebContentsPrintOptions = {
    silent: false,
    printBackground: true,
    landscape: pdf.landscape,
    pageSize: {
      width: Math.round(pageSize.width * MICRONS_PER_INCH),
      height: Math.round(pageSize.height * MICRONS_PER_INCH)
    },
    margins: {
      marginType: 'custom',
      top: toPixels(margins.top),
      bottom: toPixels(margins.bottom),
      left: toPixels(margins.left),
      right: toPixels(margins.right)
    }
  }
  if (headerFooter?.header) options.header = headerFooter.header
  if (headerFooter?.footer) options.footer = headerFooter.footer
  return options
}
