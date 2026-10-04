import { describe, it, expect } from 'vitest'
import { documentToXhtml } from './xhtml.js'
import type { PmDoc } from '../../shared/model/document.js'

function paragraph(text: string, attrs: Record<string, unknown> = {}) {
  return { type: 'paragraph', attrs, content: [{ type: 'text', text }] }
}

describe('documentToXhtml', () => {
  it('keeps an explicit right-to-left paragraph right-to-left, even when it opens in Latin', () => {
    const doc: PmDoc = { type: 'doc', content: [paragraph('Quoth שלום', { dir: 'rtl' }), paragraph('Plain.')] }
    const { body } = documentToXhtml(doc, [], 'fn')
    expect(body).toContain('<p dir="rtl">Quoth שלום</p>')
    expect(body).toContain('<p>Plain.</p>')
  })
})
