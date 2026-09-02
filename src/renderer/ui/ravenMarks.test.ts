import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RAVEN_PATHS, type RavenMark } from './ravenMarks.js'

const ICON_PATH = fileURLToPath(new URL('../../../resources/icon.svg', import.meta.url))

const VARIANTS: RavenMark[] = ['perched', 'flight', 'bust']

describe('the raven marks', () => {
  it('draws every posture, and nothing that is not one', () => {
    expect(Object.keys(RAVEN_PATHS).sort()).toEqual([...VARIANTS].sort())
  })

  for (const variant of VARIANTS) {
    describe(`"${variant}"`, () => {
      it('is closed silhouettes, not open strokes', () => {
        for (const subpath of RAVEN_PATHS[variant]) {
          expect(subpath.startsWith('M'), subpath).toBe(true)
          expect(subpath.trimEnd().endsWith('Z'), subpath).toBe(true)
        }
      })

      /*
       * A mark that leaves the 64-unit grid is not wrong anywhere it is drawn
       * large, and clipped everywhere it is drawn small — which is where an
       * icon actually lives, so it would be found last.
       */
      it('stays inside the 64-unit grid', () => {
        for (const subpath of RAVEN_PATHS[variant]) {
          for (const number of subpath.match(/-?\d+(\.\d+)?/g) ?? []) {
            expect(Number(number), `${subpath} has ${number}`).toBeGreaterThanOrEqual(0)
            expect(Number(number), `${subpath} has ${number}`).toBeLessThanOrEqual(64)
          }
        }
      })
    })
  }

  /*
   * electron-builder wants the app icon as a file on disk, so the perched raven
   * exists twice. This is the only thing keeping the second copy honest: an
   * icon quietly left behind after the mark was redrawn is a rebrand that
   * shipped everywhere except the taskbar.
   */
  it('draws the same perched raven as the packaged app icon', () => {
    const icon = readFileSync(ICON_PATH, 'utf8')
    for (const subpath of RAVEN_PATHS.perched) {
      expect(icon).toContain(subpath)
    }
  })
})
