import path from 'node:path'
import { ASSETS_DIR, ASSET_PROTOCOL } from '../../shared/constants.js'
import { parseAssetUrl } from '../../shared/model/asset.js'
import { normalizeRelative, relativeToRoot } from '../vfs/paths.js'

/**
 * Turn an image `src` back into a project-relative path, for the exporters
 * that read the bytes again (print/PDF, EPUB).
 *
 * The renderer sees images as `pub-asset://` URLs, because it has no `file://`
 * access. The current form carries the project-relative path outright; the
 * legacy form encodes an absolute local path, which is honoured only when it
 * lies inside `root`. There is deliberately no "find an `assets/` segment
 * anywhere in the path" fallback: a document naming `/etc/x/assets/key.png`
 * must not be read as this project's `assets/key.png`.
 */
export function assetPathFor(root: string, src: string): string | null {
  if (!src.startsWith(`${ASSET_PROTOCOL}://`)) return projectAsset(src)
  const parsed = parseAssetUrl(src)
  if (!parsed) return null
  if (parsed.kind === 'project') return normalized(parsed.path)
  let absolute: string
  try {
    absolute = Buffer.from(parsed.encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (!path.isAbsolute(absolute) || !path.isAbsolute(root)) return null
  const relative = relativeToRoot(root, path.resolve(absolute))
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null
  return normalized(relative)
}

function normalized(candidate: string): string | null {
  try {
    return normalizeRelative(candidate) || null
  } catch {
    return null
  }
}

function projectAsset(candidate: string): string | null {
  const relative = normalized(candidate)
  return relative?.startsWith(`${ASSETS_DIR}/`) ? relative : null
}
