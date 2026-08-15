import { describe, it, expect } from 'vitest'
import { mapIconKinds } from '@shared/model/map.js'
import { MAP_ICON_KEYS, MAP_ICON_LABELS } from './icons.js'

/**
 * The glyph table is `Record<MapIcon, JSX.Element>`, so a missing drawing is a
 * build error rather than something to test for. The labels are not typed that
 * tightly at the point of use, and a marker whose picker entry reads `undefined`
 * is exactly the kind of thing that ships unnoticed.
 */
describe('the marker icons', () => {
  it('names every icon the schema allows, and none it does not', () => {
    expect(Object.keys(MAP_ICON_LABELS).sort()).toEqual([...mapIconKinds].sort())
  })

  it('offers them to the picker in the order the schema lists them', () => {
    expect(MAP_ICON_KEYS).toEqual(mapIconKinds)
  })

  it('gives each one something readable to show', () => {
    for (const key of mapIconKinds) {
      expect(MAP_ICON_LABELS[key].length).toBeGreaterThan(0)
    }
  })
})
