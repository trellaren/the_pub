import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { protocol, net } from 'electron'
import { ASSET_PROTOCOL } from '../../shared/constants.js'
import { buildAssetUrl, parseAssetUrl, imageMimeType } from '../../shared/model/asset.js'
import { resolveInRoot, normalizeRelative } from '../vfs/paths.js'
import type { VfsAdapter } from '../vfs/types.js'

/**
 * Serves project images to the renderer.
 *
 * The renderer has no `file://` access, so images are addressed through this
 * scheme instead. A URL names a project by opaque token plus a project-relative
 * path; the token only resolves while that project is open, so a document
 * cannot reference a file outside its own project even if its `src` is
 * hand-edited, and a closed project's images stop being served at all.
 */
export function registerAssetSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

export interface AssetOwner {
  adapter: VfsAdapter
  root: string
  isLocal: boolean
}

export interface AssetLookup {
  byToken: (token: string) => AssetOwner | null
  /** Legacy URLs only: the roots the old absolute-path form is checked against. */
  roots: () => string[]
}

export function assetUrl(session: { assetToken: string }, relativePath: string): string {
  return buildAssetUrl(session.assetToken, relativePath)
}

export function registerAssetProtocol(lookup: AssetLookup): void {
  protocol.handle(ASSET_PROTOCOL, async (request) => {
    const parsed = parseAssetUrl(request.url)
    if (!parsed) return new Response('Bad asset request', { status: 400 })

    if (parsed.kind === 'project') {
      const owner = lookup.byToken(parsed.token)
      // Not forbidden: the project simply is not open, and there is nothing to
      // authorise a request against once it has closed.
      if (!owner) return new Response('Not found', { status: 404 })

      let relative: string
      try {
        relative = normalizeRelative(parsed.path)
      } catch {
        return new Response('Bad asset request', { status: 400 })
      }

      // A local project streams straight off disk — range requests and MIME
      // sniffing for free, on the path that serves every image in every open
      // document. The remote branch buffers through the project's own adapter,
      // which is precisely what makes images on SFTP/FTP/OneDrive work.
      if (owner.isLocal) {
        try {
          return await net.fetch(pathToFileURL(resolveInRoot(owner.root, relative)).toString())
        } catch {
          return new Response('Not found', { status: 404 })
        }
      }

      try {
        const bytes = await owner.adapter.readFile(relative)
        return new Response(new Uint8Array(bytes), {
          headers: {
            // net.fetch inferred this on the local branch; a byte Response
            // carries no type unless it says so.
            'Content-Type': imageMimeType(relative),
            'Content-Length': String(bytes.length),
            'Cache-Control': 'no-cache'
          }
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    }

    /*
     * Legacy: a base64url absolute path, written into documents by earlier
     * versions. Those only ever encoded local paths — the old code could not
     * serve a remote file at all — so this branch is deliberately local-only,
     * kept verbatim so old documents keep rendering.
     */
    let absolute: string
    try {
      absolute = Buffer.from(parsed.encoded, 'base64url').toString('utf8')
    } catch {
      return new Response('Bad asset request', { status: 400 })
    }

    const allowed = lookup.roots().some((root) => {
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
