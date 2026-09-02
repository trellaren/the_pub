/**
 * The raven, in three postures — the app's whole iconography.
 *
 * Silhouettes, deliberately: solid fills with no interior line, drawn on one
 * 64-unit grid so they read as one family and survive being scaled down to a
 * window icon or a tab. Detail is what fails first at 16px, which is the size
 * an app icon spends most of its life at, so there is none to lose.
 *
 * These are path data rather than components so they can be checked as data —
 * see `ravenMarks.test.ts`, which holds every mark inside the grid and keeps
 * `resources/icon.svg` (the packaged app icon, which electron-builder needs as
 * a real file on disk) drawing the same bird as the app itself.
 */
export type RavenMark = 'perched' | 'flight' | 'bust'

export const RAVEN_VIEWBOX = '0 0 64 64'

/** Every subpath of a mark, in draw order. All are closed and share one fill. */
export const RAVEN_PATHS: Record<RavenMark, readonly string[]> = {
  perched: [
    'M6.2 21.4 L17 17.8 C19 14 24 12.4 28 14.2 C31.4 15.8 33 18.8 33 21.8 C37.6 26.4 42.4 31.2 47 36.8 L60.5 55.8 L41.5 44.3 C36.5 45.8 31.5 46 27.5 44.4 C23.8 42.8 21.6 39.6 20.8 36.2 C20 32.6 19 29.2 18 26.4 C17.6 25 17.2 24 17 23.2 L6.2 21.4 Z',
    'M25 44.3 L27.6 44.3 L27.6 53.7 L22.2 56.1 L22.2 54.2 L25 52.5 Z',
    'M31 44.8 L33.4 44.8 L33.4 53.4 L28.2 55.7 L28.2 53.8 L31 52.1 Z'
  ],
  flight: [
    'M5 30.8 L15.5 26.8 C19 23.6 24.2 24.2 27.2 27.8 C33.4 30.2 40.2 33.4 46.2 37.4 L59.4 48 L44 43.6 C36 43.8 28 41.8 22 38.6 C17.4 36.2 14.2 33.2 13 31 Z',
    'M27.5 30.6 C23 23 17 15.4 8.6 8.6 C7.4 17.4 9.6 26 14.8 32.2 C18 36 22.4 38.8 27 40 Z',
    'M33 31.4 C38.6 23.4 46.4 15 56.4 7.6 C57 16.6 54 25.4 48.4 32 C44.8 36.2 40.2 39.4 35.6 41 Z'
  ],
  bust: [
    'M3.2 25.8 L17 23.4 C19.2 17.8 25.6 15.2 31.6 18.6 C38.2 22.2 39.6 30.8 34.8 36.4 C33.2 40.4 34.2 44.6 37.8 48.8 C31 47.8 25 45.2 20.4 41.2 C15.6 37.2 13.2 32.6 13.2 28.4 L3.2 25.8 Z'
  ]
}
