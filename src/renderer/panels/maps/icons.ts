import { mapIconKinds, type MapIcon } from '@shared/model/map.js'

/**
 * The marker icon set, named.
 *
 * Kept apart from the drawings in `MapIconGlyph.tsx` so this stays a plain
 * module: vitest collects `.ts` only, and the names are the half that can drift
 * — a glyph missing from `Record<MapIcon, JSX.Element>` is a build error, a
 * label missing from here is a picker entry reading `undefined`.
 */
export const MAP_ICON_KEYS: readonly MapIcon[] = mapIconKinds

export const MAP_ICON_LABELS: Record<MapIcon, string> = {
  city: 'City',
  town: 'Town',
  village: 'Village',
  castle: 'Castle',
  tower: 'Tower',
  bridge: 'Bridge',
  forest: 'Forest',
  mountain: 'Mountain',
  cave: 'Cave',
  ruins: 'Ruins',
  temple: 'Temple',
  farm: 'Farm',
  mine: 'Mine',
  port: 'Port',
  lighthouse: 'Lighthouse',
  camp: 'Camp',
  crossroads: 'Crossroads',
  flag: 'Flag',
  star: 'Star',
  waypoint: 'Waypoint'
}
