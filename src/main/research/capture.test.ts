import { describe, it, expect } from 'vitest'
import { capturePage, applyCaptureToCslFields, type CaptureFetch } from './capture.js'

function fakeFetch(html: string, opts: { ok?: boolean; status?: number } = {}): CaptureFetch {
  return async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => html
  })
}

const FIXED_NOW = () => new Date('2026-08-17T12:00:00Z')

describe('capturePage', () => {
  it('extracts title and readable text, writing accessed and URL', async () => {
    const html = `
      <html><head><title>An Article &amp; More</title></head>
      <body><nav>skip me</nav><p>The quick brown fox.</p><script>evil()</script></body></html>
    `
    const result = await capturePage('https://example.com/a', fakeFetch(html), FIXED_NOW)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.capture.title).toBe('An Article & More')
    expect(result.capture.text).toContain('The quick brown fox.')
    expect(result.capture.text).not.toContain('skip me')
    expect(result.capture.text).not.toContain('evil()')
    expect(result.capture.url).toBe('https://example.com/a')
    expect(result.capture.accessed).toBe('2026-08-17')
  })

  it('falls back to the URL as the title when none is present', async () => {
    const result = await capturePage('https://example.com/no-title', fakeFetch('<p>Body only</p>'), FIXED_NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.capture.title).toBe('https://example.com/no-title')
  })

  it('reports not-found on a 404', async () => {
    const result = await capturePage('https://example.com/gone', fakeFetch('', { ok: false, status: 404 }))
    expect(result).toEqual({ ok: false, reason: 'not-found' })
  })

  it('reports offline when fetch throws', async () => {
    const throwing: CaptureFetch = async () => {
      throw new Error('network down')
    }
    const result = await capturePage('https://example.com/x', throwing)
    expect(result).toEqual({ ok: false, reason: 'offline' })
  })

  it('reports unreadable when the page has no extractable text', async () => {
    const result = await capturePage('https://example.com/empty', fakeFetch('<html><body></body></html>'))
    expect(result).toEqual({ ok: false, reason: 'unreadable' })
  })
})

describe('applyCaptureToCslFields', () => {
  it('writes URL and a CSL date-parts accessed field citeproc can render', () => {
    expect(applyCaptureToCslFields('https://example.com/a', '2026-08-17')).toEqual({
      URL: 'https://example.com/a',
      accessed: { 'date-parts': [[2026, 8, 17]] }
    })
  })
})
