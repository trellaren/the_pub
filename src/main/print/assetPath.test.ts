import path from 'node:path'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { assetPathFor } from './assetPath.js'
import { buildAssetUrl } from '../../shared/model/asset.js'
import { ASSET_PROTOCOL } from '../../shared/constants.js'

const root = path.join(os.tmpdir(), 'novel')
const legacy = (absolute: string): string => `${ASSET_PROTOCOL}://asset/${Buffer.from(absolute).toString('base64url')}`

describe('assetPathFor', () => {
  it('reads the current URL form', () => {
    expect(assetPathFor(root, buildAssetUrl('tok', 'assets/cover.png'))).toBe('assets/cover.png')
  })

  it('accepts a bare assets path, and nothing that climbs out of it', () => {
    expect(assetPathFor(root, 'assets/map.png')).toBe('assets/map.png')
    expect(assetPathFor(root, 'assets/../../secret.png')).toBeNull()
    expect(assetPathFor(root, 'chapter.pubdoc')).toBeNull()
  })

  it('unwinds a legacy absolute path inside the root', () => {
    expect(assetPathFor(root, legacy(path.join(root, 'assets', 'old.png')))).toBe('assets/old.png')
  })

  it('refuses a legacy path outside the root, even one with an assets segment', () => {
    expect(assetPathFor(root, legacy(path.join(os.tmpdir(), 'elsewhere', 'assets', 'key.png')))).toBeNull()
    expect(assetPathFor(root, legacy(`${root}-sibling/assets/x.png`))).toBeNull()
  })

  it('refuses a legacy path against a remote root', () => {
    expect(assetPathFor('sftp://01ABC/books', legacy('/home/me/books/assets/x.png'))).toBeNull()
  })
})
