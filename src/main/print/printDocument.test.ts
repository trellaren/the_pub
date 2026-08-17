import { describe, it, expect } from 'vitest'
import { buildPrintHtml } from './printDocument.js'
import { BUILTIN_STYLES } from '../../shared/model/style.js'
import type { PageSetup } from '../../shared/model/document.js'

const setup: PageSetup = { width: 612, height: 792, margin: 72, orientation: 'portrait', columns: 1 }

describe('buildPrintHtml', () => {
  it('emits a @page rule sized from the page setup, in points', () => {
    const html = buildPrintHtml(
      [{ title: 'Chapter One', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] } }],
      BUILTIN_STYLES,
      setup,
      new Map()
    )
    expect(html).toContain('@page { size: 612pt 792pt; margin: 72pt; }')
    expect(html).toContain('Hello')
  })

  it('breaks before every document after the first', () => {
    const doc = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'x' }] }] }
    const html = buildPrintHtml(
      [
        { title: 'One', content: doc },
        { title: 'Two', content: doc }
      ],
      BUILTIN_STYLES,
      setup,
      new Map()
    )
    expect(html.match(/break-before: page/g)?.length).toBe(1)
  })

  it('inlines images referenced by the document as data URIs', () => {
    const doc = {
      type: 'doc' as const,
      content: [{ type: 'image' as const, attrs: { src: 'assets/cover.png' } }]
    }
    const png = new Uint8Array([1, 2, 3, 4])
    const html = buildPrintHtml(
      [{ title: 'One', content: doc }],
      BUILTIN_STYLES,
      setup,
      new Map([['cover.png', { data: png, extension: 'png' }]])
    )
    expect(html).toContain('data:image/png;base64,')
    expect(html).not.toContain('../images/')
  })

  it('flips width/height for landscape orientation', () => {
    const landscape: PageSetup = { ...setup, orientation: 'landscape' }
    const html = buildPrintHtml(
      [{ title: 'One', content: { type: 'doc', content: [] } }],
      BUILTIN_STYLES,
      landscape,
      new Map()
    )
    expect(html).toContain('@page { size: 792pt 612pt; margin: 72pt; }')
  })
})
