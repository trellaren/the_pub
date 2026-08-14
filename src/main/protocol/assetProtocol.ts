import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { protocol, net } from 'electron'
import { ASSET_PROTOCOL } from '../../shared/constants.js'
import { resolveInRoot } from '../vfs/paths.js'

/**
 * Serves project images to the renderer.
 *
 * The renderer has no `file://` access, so images are addressed through this
 * scheme instead. Every request is re-resolved against the roots of the
 * currently open projects, which means a document cannot reference a file
 * outside the project it lives in even if its `src` is hand-edited.
 */
export function registerAssetSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

export function assetUrl(root: string, relativePath: string): string {
  const token = Buffer.from(path.join(root, relativePath), 'utf8').toString('base64url')
  return `${ASSET_PROTOCOL}://asset/${token}`
}

export function registerAssetProtocol(getRoots: () => string[]): void {
  protocol.handle(ASSET_PROTOCOL, async (request) => {
    let absolute: string
    try {
      const token = new URL(request.url).pathname.replace(/^\//, '')
      absolute = Buffer.from(token, 'base64url').toString('utf8')
    } catch {
      return new Response('Bad asset request', { status: 400 })
    }

    const allowed = getRoots().some((root) => {
      try {
        return resolveInRoot(root, path.relative(root, absolute)) === path.resolve(absolute)
      } catch {
        return false
      }
    })
    if (!allowed) return new Response('Forbidden', { status: 403 })

    try {
      return await net.fetch(pathToFileURL(absolute).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
