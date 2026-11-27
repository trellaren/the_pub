/**
 * What `AppState.platform` reads on the iOS build, where it is a constant
 * rather than Node's `process.platform`.
 */
export const IOS_PLATFORM = 'ios'

/**
 * Whether the app is running as a desktop program: its own windows, a file
 * manager to reveal things in, raw sockets for SFTP and SQL, and a native
 * runtime for an embedded model. The iOS build has none of those, and the UI
 * asks this rather than offering what cannot work there.
 */
export function isDesktopPlatform(platform: string | undefined): boolean {
  return platform !== IOS_PLATFORM
}
