import type { AppState } from './model/app.js'

/** Display names for every selectable theme, in menu/palette order. */
export const THEMES: Array<{ id: AppState['theme']; label: string }> = [
  { id: 'dark', label: 'Regular Dark' },
  { id: 'light', label: 'Regular Light' },
  { id: 'blue', label: 'Blue' },
  { id: 'dark-purple', label: 'Dark Purple' },
  { id: 'edinburgh-cafe', label: 'Edinburgh Café' },
  { id: 'gloomy-castle', label: 'Gloomy Castle' },
  { id: 'gritty-philadelphia', label: 'Gritty Philadelphia' },
  { id: 'hokkaido', label: 'Hokkaido' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'red', label: 'Red' },
  { id: 'scottish-highlands', label: 'Scottish Highlands' },
  { id: 'tokyo', label: 'Tokyo' }
]
