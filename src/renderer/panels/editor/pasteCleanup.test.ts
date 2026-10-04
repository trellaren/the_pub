import { describe, it, expect } from 'vitest'
import { cleanPastedHtml } from './pasteCleanup.js'

describe('cleanPastedHtml', () => {
  it('strips Word clutter and keeps the writing', () => {
    const word =
      '<p class=MsoNormal style="mso-margin-top-alt:auto;color:red;mso-bidi-font-family:Arial">' +
      'Hello<o:p></o:p></p>' +
      '<!--[if gte vml 1]><v:shape>junk</v:shape><![endif]--><![if !vml]><span>kept</span><![endif]>'
    expect(cleanPastedHtml(word).html).toBe('<p class=MsoNormal style="color:red">Hello</p><span>kept</span>')
  })

  it('drops a style attribute that held only mso declarations', () => {
    expect(cleanPastedHtml("<span style='mso-spacerun:yes'>a</span>").html).toBe('<span>a</span>')
  })

  it('counts inline data images the schema will refuse', () => {
    const html = '<img src="data:image/png;base64,AAA"><img src="https://example.com/a.png"><IMG SRC=\'data:image/gif;base64,B\'>'
    expect(cleanPastedHtml(html).droppedImages).toBe(2)
  })

  it('leaves ordinary HTML alone', () => {
    const html = '<p style="text-align: center">Plain <b>bold</b></p>'
    expect(cleanPastedHtml(html)).toEqual({ html, droppedImages: 0 })
  })
})
