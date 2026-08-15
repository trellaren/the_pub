import { ASSET_PROTOCOL } from '../constants.js'

/*
 * Asset URLs, shared between main and the renderer.
 *
 * Two forms exist. The current one names a project by an opaque token plus a
 * project-relative path, so main can serve it through whichever VfsAdapter owns
 * that project — which is what makes images work on SFTP, FTP and OneDrive
 * projects, not only local folders:
 *
 *     pub-asset://asset/v2/<token>/<segment>/<segment>…
 *
 * The legacy form base64url-encodes an absolute local path. It survives only
 * because documents written by earlier versions embed it in their image srcs:
 *
 *     pub-asset://asset/<base64url(absolute path)>
 *
 * The two are provably disjoint — a base64url token can never equal 'v2' — so
 * parsing never guesses. One implementation lives here so main (minting URLs
 * for `doc:writeAsset`) and the renderer (minting them for a stored map
 * background) cannot drift apart.
 */

export const ASSET_URL_VERSION = 'v2'

/** The url prefix every project asset shares; `OpenProject` carries the token. */
export function buildAssetUrl(projectToken: string, relativePath: string): string {
  const segments = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${ASSET_PROTOCOL}://asset/${ASSET_URL_VERSION}/${projectToken}/${segments}`
}

export type ParsedAssetUrl =
  | { kind: 'project'; token: string; path: string }
  /** The base64url token, undecoded: this file also runs in the renderer, which
   * has no Buffer, and only main ever follows a legacy URL anyway. */
  | { kind: 'legacy'; encoded: string }

export function parseAssetUrl(url: string): ParsedAssetUrl | null {
  let pathname: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${ASSET_PROTOCOL}:`) return null
    pathname = parsed.pathname.replace(/^\//, '')
  } catch {
    return null
  }

  const [first, ...rest] = pathname.split('/')
  if (first !== ASSET_URL_VERSION) {
    // Legacy: the whole pathname is one base64url token holding an absolute path.
    if (!first || rest.length > 0) return null
    return { kind: 'legacy', encoded: first }
  }

  const [token, ...segments] = rest
  if (!token || segments.length === 0) return null
  const decoded: string[] = []
  for (const segment of segments) {
    let piece: string
    try {
      piece = decodeURIComponent(segment)
    } catch {
      return null
    }
    // The same rules normalizeRelative enforces at the VFS boundary: a segment
    // that climbs or restarts the path is an attack or a bug, never a request.
    if (!piece || piece === '.' || piece === '..' || piece.includes('/') || piece.includes('\\')) {
      return null
    }
    decoded.push(piece)
  }
  return { kind: 'project', token, path: decoded.join('/') }
}

/*
 * Deliberately not the rendererServer's MIME table: that one serves the app
 * bundle (scripts, styles, source maps) and has different membership rules.
 * This one answers only "what image is this file?".
 */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}

export function imageMimeType(relativePath: string): string {
  const dot = relativePath.lastIndexOf('.')
  const extension = dot === -1 ? '' : relativePath.slice(dot + 1).toLowerCase()
  return IMAGE_TYPES[extension] ?? 'application/octet-stream'
}
