import type { AppState } from './model/app.js'
import { THEME_OPTIONS } from './settings/registry.js'

/**
 * Display names for every selectable theme, in menu/palette order.
 *
 * Derived from the settings registry, which is where the list actually lives —
 * a theme added in only one of the two places used to be either unselectable or
 * unlabelled.
 */
export const THEMES: Array<{ id: AppState['theme']; label: string }> = THEME_OPTIONS.map(
  ({ value, label }) => ({ id: value, label })
)
