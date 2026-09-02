import { groupAdjacent } from './adjacentGroups.js'
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

/**
 * The same themes, in the same order, under their headings — for the menu and
 * the settings picker, which both go unreadable as one flat list of twenty.
 */
export const THEME_GROUPS: Array<{
  label: string
  themes: Array<{ id: AppState['theme']; label: string }>
}> = groupAdjacent(THEME_OPTIONS, (option) => option.group).map((run) => ({
  label: run.group ?? '',
  themes: run.items.map(({ value, label }) => ({ id: value, label }))
}))

/**
 * Whether each theme is built out of light or dark colours.
 *
 * This is not decoration: it is stamped on the document as `color-scheme`, and
 * that is what decides whether a `<select>`, a native scrollbar or the flash of
 * background before first paint comes up light or dark. It used to be set to
 * the theme *id*, which is a valid value for exactly two of them and ignored
 * for the rest — so every other theme got form controls from the wrong world.
 */
export const THEME_SCHEMES: Record<AppState['theme'], 'light' | 'dark'> = Object.fromEntries(
  THEME_OPTIONS.map(({ value, scheme }) => [value, scheme])
) as Record<AppState['theme'], 'light' | 'dark'>

/**
 * The themes that promise WCAG AAA rather than the AA every theme meets.
 *
 * Read off the registry's `contrast` marker in one place, because a marker only
 * one file knows how to read is a marker that stops being checked.
 */
export const AAA_THEMES: ReadonlySet<AppState['theme']> = new Set(
  THEME_OPTIONS.filter((option) => 'contrast' in option && option.contrast === 'aaa').map(
    (option) => option.value
  )
)

/** The theme a window paints before app state has been read. */
export const DEFAULT_THEME: AppState['theme'] = 'raven'
