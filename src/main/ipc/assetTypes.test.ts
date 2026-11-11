import { describe, expect, it } from 'vitest'
import { isImageAssetExtension } from './assetTypes.js'

describe('isImageAssetExtension', () => {
  it.each(['png', 'JPG', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', ''])('accepts %s', (ext) => {
    expect(isImageAssetExtension(ext)).toBe(true)
  })

  it.each(['html', 'js', 'exe', 'pdf', 'ttf', 'pubdoc', 'png/../x'])('refuses %s', (ext) => {
    expect(isImageAssetExtension(ext)).toBe(false)
  })
})
