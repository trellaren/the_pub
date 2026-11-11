import type { Session } from 'electron'

/**
 * The only web permission the renderer uses: `navigator.clipboard.writeText`
 * (the AI panel's copy button, the progress panel's stats copy). Electron's
 * default grants everything else too — camera, microphone, geolocation,
 * notifications, HID/serial — to any content that asks, which a page reached
 * through a bug in the renderer must not inherit.
 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])

export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}

export function installPermissionPolicy(session: Session): void {
  session.setPermissionRequestHandler((_contents, permission, callback) => callback(isPermissionAllowed(permission)))
  session.setPermissionCheckHandler((_contents, permission) => isPermissionAllowed(permission))
  session.setDevicePermissionHandler(() => false)
}
