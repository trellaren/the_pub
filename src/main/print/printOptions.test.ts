import { describe, it, expect } from 'vitest'
import { buildPdfOptions } from './printOptions.js'
import type { PageSetup } from '../../shared/model/document.js'

const usLetter: PageSetup = { width: 612, height: 792, margin: 72, orientation: 'portrait', columns: 1 }

describe('buildPdfOptions', () => {
  it('converts points to inches for page size and margins', () => {
    const options = buildPdfOptions(usLetter)
    expect(options.pageSize).toEqual({ width: 8.5, height: 11 })
    expect(options.margins).toEqual({ marginType: 'custom', top: 1, bottom: 1, left: 1, right: 1 })
  })

  it('sets preferCSSPageSize so the print route\'s own @page rule wins', () => {
    expect(buildPdfOptions(usLetter).preferCSSPageSize).toBe(true)
  })

  it('flips width/height and sets landscape when orientation is landscape', () => {
    const landscape: PageSetup = { ...usLetter, orientation: 'landscape' }
    const options = buildPdfOptions(landscape)
    expect(options.landscape).toBe(true)
    expect(options.pageSize).toEqual({ width: 11, height: 8.5 })
  })

  it('omits header/footer templates when none are given', () => {
    const options = buildPdfOptions(usLetter)
    expect(options.displayHeaderFooter).toBeUndefined()
  })

  it('turns on header/footer templates when a running header is given', () => {
    const options = buildPdfOptions(usLetter, { header: '<div>Surname / TITLE / <span class="pageNumber"></span></div>' })
    expect(options.displayHeaderFooter).toBe(true)
    expect(options.headerTemplate).toContain('Surname')
    expect(options.footerTemplate).toBe('<span></span>')
  })
})
