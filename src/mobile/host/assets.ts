import { parseAssetUrl, assetMimeType } from '../../shared/model/asset.js'
import { normalizeRelative } from '../../main/vfs/paths.js'
import type { SessionRegistry } from '../../main/ipc/registerHandlers.js'

/**
 * The bytes behind an asset URL — what Electron's `pub-asset:` protocol
 * handler answers on desktop. A WebView cannot register a scheme from script,
 * so the page asks for the bytes and shows them itself.
 *
 * Only the token form is served. The legacy form names an absolute path on the
 * desktop machine that wrote it, which means nothing on this device.
 */
export async function readAsset(
  sessions: SessionRegistry,
  url: string
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const parsed = parseAssetUrl(url)
  if (!parsed || parsed.kind !== 'project') return null
  const session = sessions.byAssetToken(parsed.token)
  if (!session) return null
  const relative = normalizeRelative(parsed.path)
  const bytes = await session.adapter.readFile(relative)
  return { bytes: new Uint8Array(bytes), mime: assetMimeType(relative) }
}
