import { describe, it, expect } from 'vitest'
import { generateFontFaceSheet } from './projectFonts.js'

const TOKEN = 'abc123'

describe('generateFontFaceSheet', () => {
  it('declares each imported font against its asset URL', () => {
    const css = generateFontFaceSheet(
      [{ id: '01A', family: 'Libre Baskerville', file: '.thepub/fonts/01A.ttf' }],
      TOKEN
    )
    expect(css).toContain('@font-face')
    expect(css).toContain('font-family: "Libre Baskerville"')
    // Served over the asset protocol, which is what makes the face load on
    // SFTP/FTP/OneDrive projects exactly as it does on a local folder.
    expect(css).toContain('pub-asset://')
    expect(css).toContain(TOKEN)
    expect(css).toContain('01A.ttf')
  })

  it('cannot be broken out of by a hostile filename', () => {
    // The family comes from a filename the user picked, but a shared project's
    // fonts were imported by *someone else* — this string reaches every window
    // as CSS and must stay a string.
    const css = generateFontFaceSheet(
      [{ id: 'x', family: 'a"; } body { display: none } @font-face { font-family: "b', file: '.thepub/fonts/x.ttf' }],
      TOKEN
    )
    expect(css).not.toContain('a"; }')
    expect(css).toContain('a\\";')
  })

  it('is empty for a project with no imported fonts', () => {
    expect(generateFontFaceSheet([], TOKEN)).toBe('')
  })
})
