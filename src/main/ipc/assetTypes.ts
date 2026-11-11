import { assetMimeType } from '../../shared/model/asset.js'

/**
 * Only image types the asset protocol serves as images. Anything else written
 * under `assets/` — `.html`, `.js`, an executable — would be served back with
 * a guessed type, or sit in the project as a file the writer never chose.
 * Empty falls through to `writeAsset`'s own `png` default.
 */
export function isImageAssetExtension(ext: string): boolean {
  return ext === '' || assetMimeType(`asset.${ext}`).startsWith('image/')
}
