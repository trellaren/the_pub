import { buildAssetUrl } from '@shared/model/asset.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'

/**
 * The displayable URL for a project-relative asset path, or null when no
 * project is open. Synchronous on purpose: `OpenProject` carries the token so
 * a stored map background never costs an IPC round trip inside a render.
 */
export function assetUrlFor(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null
  const token = useProjectStore.getState().project?.assetToken
  return token ? buildAssetUrl(token, relativePath) : null
}

/** The hook form, for components that must re-resolve when the project changes. */
export function useAssetUrl(relativePath: string | null | undefined): string | null {
  const token = useProjectStore((store) => store.project?.assetToken)
  if (!relativePath || !token) return null
  return buildAssetUrl(token, relativePath)
}

/**
 * Encode bytes for the IPC boundary in chunks — one big spread would blow the
 * argument limit on a large image.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
