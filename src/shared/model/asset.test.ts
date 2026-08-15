import { describe, it, expect } from 'vitest'
import { buildAssetUrl, parseAssetUrl, imageMimeType } from './asset.js'

const TOKEN = 'a'.repeat(32)

describe('asset urls', () => {
  it('round-trips a project path through build and parse', () => {
    const url = buildAssetUrl(TOKEN, 'assets/01ABC.png')
    expect(parseAssetUrl(url)).toEqual({ kind: 'project', token: TOKEN, path: 'assets/01ABC.png' })
  })

  it('survives spaces, hashes and non-ASCII in filenames', () => {
    for (const name of ['maps/old world #2.png', 'assets/carte général.webp', 'a b/c d.gif']) {
      const parsed = parseAssetUrl(buildAssetUrl(TOKEN, name))
      expect(parsed).toEqual({ kind: 'project', token: TOKEN, path: name })
    }
  })

  it('rejects a path that climbs, restarts, or hides a separator', () => {
    // Hand-built, because buildAssetUrl itself never produces these.
    expect(parseAssetUrl(`pub-asset://asset/v2/${TOKEN}/..%2Fsecrets`)).toBeNull()
    expect(parseAssetUrl(`pub-asset://asset/v2/${TOKEN}/a%2F..%2Fb`)).toBeNull()
    expect(parseAssetUrl(`pub-asset://asset/v2/${TOKEN}/.`)).toBeNull()
    expect(parseAssetUrl(`pub-asset://asset/v2/${TOKEN}/`)).toBeNull()
    expect(parseAssetUrl(`pub-asset://asset/v2/${TOKEN}`)).toBeNull()
  })

  /*
   * A literal `..` never reaches the segment check at all: the WHATWG URL
   * parser resolves dot-segments in the pathname first, so `a/../b` arrives as
   * `b` — already contained. The check above guards the encoded forms the URL
   * parser leaves alone. Pinned so a future parser swap that stops normalising
   * shows up as a failure here rather than as a traversal.
   */
  it('sees dot-segments resolved by the URL parser before parsing', () => {
    expect(parseAssetUrl(`pub-asset://asset/v2/${TOKEN}/a/../b`)).toEqual({
      kind: 'project',
      token: TOKEN,
      path: 'b'
    })
    // Climbing above the version segment destroys the shape entirely.
    expect(parseAssetUrl(`pub-asset://asset/v2/${TOKEN}/../../../etc/passwd`)).toBeNull()
  })

  /*
   * The legacy form is a single base64url token holding an absolute path. It
   * can never collide with the project form because base64url has no way to
   * spell 'v2' as a lone first segment followed by more segments.
   */
  it('reads the legacy single-token form as legacy, never as project', () => {
    const encoded = Buffer.from('/home/author/project/assets/x.png', 'utf8').toString('base64url')
    expect(parseAssetUrl(`pub-asset://asset/${encoded}`)).toEqual({ kind: 'legacy', encoded })
  })

  it('refuses other schemes and junk outright', () => {
    expect(parseAssetUrl('https://asset/v2/tok/a.png')).toBeNull()
    expect(parseAssetUrl('not a url')).toBeNull()
    expect(parseAssetUrl('pub-asset://asset/legacy/extra/segments')).toBeNull()
  })
})

describe('imageMimeType', () => {
  it('knows the formats an author will actually import', () => {
    expect(imageMimeType('a.png')).toBe('image/png')
    expect(imageMimeType('a.jpg')).toBe('image/jpeg')
    expect(imageMimeType('a.JPEG')).toBe('image/jpeg')
    expect(imageMimeType('a.gif')).toBe('image/gif')
    expect(imageMimeType('a.webp')).toBe('image/webp')
    expect(imageMimeType('a.avif')).toBe('image/avif')
    expect(imageMimeType('a.bmp')).toBe('image/bmp')
    expect(imageMimeType('a.svg')).toBe('image/svg+xml')
  })

  it('answers octet-stream for anything else', () => {
    expect(imageMimeType('a.tiff')).toBe('application/octet-stream')
    expect(imageMimeType('no-extension')).toBe('application/octet-stream')
  })
})
