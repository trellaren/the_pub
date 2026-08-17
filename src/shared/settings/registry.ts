import { z } from 'zod'
import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS } from '../constants.js'

/**
 * Every preference The Pub has, in one flat list.
 *
 * Before this, a setting existed in four places that had to be kept in step by
 * hand: a field on a zod schema, a control in `SettingsPanel`, a default
 * somewhere, and a label. Adding one meant remembering all four, and the panel
 * grew a hand-written block per value. Here a setting is one entry, and both
 * the on-disk schema and the panel are derived from it.
 *
 * What this deliberately does *not* change is the shape on disk. `storageKey`
 * is the property name in the persisted object — `settings.autosaveDebounceMs`
 * in the manifest, `theme` at the root of app state — while `key` is the dotted
 * id the registry and the UI address a setting by. Keeping them separate is
 * what lets the registry be reorganised without a manifest migration.
 */
export type SettingScope = 'app' | 'project'

/**
 * How the panel should render a setting. A `select` either carries its options
 * or names a source the renderer resolves — the project's own named styles are
 * not knowable from here, and reaching for them would drag project state into
 * a module both processes import.
 */
export type SettingControl =
  | { kind: 'number'; step?: number }
  | { kind: 'boolean' }
  | { kind: 'text' }
  | { kind: 'select'; options: ReadonlyArray<{ value: string; label: string }> }
  | { kind: 'select'; optionsFrom: 'projectStyles' }
  /**
   * Named suggestions that are not the only allowed values — a text field with
   * a datalist. A plain `select` cannot express this, and using one for a
   * setting whose schema is an open string silently narrows it to the handful
   * of options someone happened to list.
   */
  | { kind: 'combo'; options: ReadonlyArray<{ value: string; label: string }> }

export interface SettingDef {
  key: string
  storageKey: string
  scope: SettingScope
  /** Section heading the panel groups this under, in first-seen order. */
  group: string
  title: string
  description?: string
  schema: z.ZodType
  control: SettingControl
}

/**
 * Selectable themes, and the single place they are listed.
 *
 * `THEMES` in `shared/themes.ts` and the app-state enum are both derived from
 * this: a theme used to have to be added to both, and one that reached only
 * the enum was selectable by nothing.
 */
export const THEME_OPTIONS = [
  { value: 'dark', label: 'Regular Dark' },
  { value: 'light', label: 'Regular Light' },
  { value: 'blue', label: 'Blue' },
  { value: 'dark-purple', label: 'Dark Purple' },
  { value: 'edinburgh-cafe', label: 'Edinburgh Café' },
  { value: 'gloomy-castle', label: 'Gloomy Castle' },
  { value: 'gritty-philadelphia', label: 'Gritty Philadelphia' },
  { value: 'hokkaido', label: 'Hokkaido' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'red', label: 'Red' },
  { value: 'scottish-highlands', label: 'Scottish Highlands' },
  { value: 'tokyo', label: 'Tokyo' },
  { value: 'high-contrast', label: 'High Contrast' }
] as const

const THEME_IDS = [
  'dark',
  'light',
  'blue',
  'dark-purple',
  'edinburgh-cafe',
  'gloomy-castle',
  'gritty-philadelphia',
  'hokkaido',
  'ocean',
  'red',
  'scottish-highlands',
  'tokyo',
  'high-contrast'
] as const

const CITATION_STYLE_OPTIONS = [
  { value: 'chicago-author-date', label: 'Chicago (author-date)' },
  { value: 'chicago-notes-bibliography', label: 'Chicago (notes-bibliography)' },
  { value: 'apa', label: 'APA' },
  { value: 'modern-language-association', label: 'MLA' }
] as const

export const SETTING_DEFS = [
  {
    key: 'app.theme',
    storageKey: 'theme',
    scope: 'app',
    group: 'Application',
    title: 'Theme',
    schema: z.enum(THEME_IDS).default('dark'),
    control: { kind: 'select', options: THEME_OPTIONS }
  },
  {
    key: 'app.timelineOrientation',
    storageKey: 'timelineOrientation',
    scope: 'app',
    group: 'Application',
    title: 'Timeline orientation',
    description: 'Which way a chronology runs in the Timeline panel.',
    schema: z.enum(['horizontal', 'vertical']).default('horizontal'),
    control: {
      kind: 'select',
      options: [
        { value: 'horizontal', label: 'Horizontal' },
        { value: 'vertical', label: 'Vertical' }
      ]
    }
  },
  {
    key: 'app.ai.enabled',
    storageKey: 'aiEnabled',
    scope: 'app',
    group: 'AI',
    title: 'Enable AI features',
    description:
      'Off removes the AI panel and its commands entirely, rather than greying them out. Conversations and stored keys are kept, so turning it back on restores them.',
    schema: z.boolean().default(true),
    control: { kind: 'boolean' }
  },
  {
    key: 'app.ai.embeddedIdleMinutes',
    storageKey: 'embeddedIdleMinutes',
    scope: 'app',
    group: 'AI',
    title: 'Unload the embedded model after (minutes)',
    description:
      'An embedded model holds gigabytes of memory while it is loaded. Zero keeps it loaded until the app quits.',
    schema: z.number().int().min(0).max(240).default(10),
    control: { kind: 'number', step: 5 }
  },
  {
    key: 'app.stats.idleTimeoutMinutes',
    storageKey: 'statsIdleTimeoutMinutes',
    scope: 'app',
    group: 'Writing stats',
    title: 'Idle timeout for active minutes (minutes)',
    description:
      'How long without typing before a writing session is considered over. Active minutes are the sum of sessions, so leaving the app open does not count as writing.',
    schema: z.number().int().min(1).max(60).default(5),
    control: { kind: 'number', step: 1 }
  },
  {
    key: 'project.autosave.debounceMs',
    storageKey: 'autosaveDebounceMs',
    scope: 'project',
    group: 'Project',
    title: 'Autosave delay (ms)',
    description: 'How long after the last keystroke a document is written.',
    schema: z.number().int().min(100).max(30_000).default(AUTOSAVE_DEBOUNCE_MS),
    control: { kind: 'number', step: 100 }
  },
  {
    key: 'project.autosave.maxWaitMs',
    storageKey: 'autosaveMaxWaitMs',
    scope: 'project',
    group: 'Project',
    title: 'Autosave maximum wait (ms)',
    description: 'The longest autosave will hold off while typing continues.',
    schema: z.number().int().min(500).max(120_000).default(AUTOSAVE_MAX_WAIT_MS),
    control: { kind: 'number', step: 500 }
  },
  {
    key: 'project.snapshots.enabled',
    storageKey: 'snapshotsEnabled',
    scope: 'project',
    group: 'Project',
    title: 'Keep version history',
    schema: z.boolean().default(true),
    control: { kind: 'boolean' }
  },
  {
    key: 'project.page.width',
    storageKey: 'pageWidth',
    scope: 'project',
    group: 'Page setup',
    title: 'Page width (pt)',
    description: '612×792 is US Letter; A4 is 595×842.',
    schema: z.number().default(612),
    control: { kind: 'number' }
  },
  {
    key: 'project.page.height',
    storageKey: 'pageHeight',
    scope: 'project',
    group: 'Page setup',
    title: 'Page height (pt)',
    schema: z.number().default(792),
    control: { kind: 'number' }
  },
  {
    key: 'project.page.margin',
    storageKey: 'pageMargin',
    scope: 'project',
    group: 'Page setup',
    title: 'Margin (pt)',
    schema: z.number().default(72),
    control: { kind: 'number' }
  },
  {
    key: 'project.styles.defaultId',
    storageKey: 'defaultStyleId',
    scope: 'project',
    group: 'Page setup',
    title: 'Default style',
    schema: z.string().default('body'),
    control: { kind: 'select', optionsFrom: 'projectStyles' }
  },
  {
    key: 'project.citations.styleId',
    storageKey: 'citationStyleId',
    scope: 'project',
    group: 'Citations',
    title: 'Citation style',
    description:
      'Any CSL style id — the four suggested here are not the only ones. IEEE, Harvard, Vancouver and several hundred journal styles are bundled and can be typed in by id.',
    schema: z.string().default('chicago-author-date'),
    control: { kind: 'combo', options: CITATION_STYLE_OPTIONS }
  }
] as const satisfies readonly SettingDef[]

export type SettingDefs = typeof SETTING_DEFS
export type AnySettingDef = SettingDefs[number]
export type SettingKey = AnySettingDef['key']

type DefsInScope<S extends SettingScope> = Extract<AnySettingDef, { scope: S }>

/** The persisted object for a scope, keyed the way it is actually stored. */
type ScopeShape<S extends SettingScope> = {
  [D in DefsInScope<S> as D['storageKey']]: D['schema']
}

/**
 * The zod object a scope's stored settings are parsed with.
 *
 * Built from the defs rather than written out, so a setting cannot exist in the
 * panel without existing on disk or the other way round. The cast is confined
 * here: the mapped type above states the result exactly, and the loop produces
 * it — TypeScript just cannot see that a `for` over a tuple builds that shape.
 */
export function buildScopeSchema<S extends SettingScope>(scope: S): z.ZodObject<ScopeShape<S>> {
  const shape: Record<string, z.ZodType> = {}
  for (const def of SETTING_DEFS) {
    if (def.scope === scope) shape[def.storageKey] = def.schema
  }
  return z.object(shape) as z.ZodObject<ScopeShape<S>>
}

export function settingsForScope(scope: SettingScope): AnySettingDef[] {
  return SETTING_DEFS.filter((def) => def.scope === scope)
}

/** Group headings for a scope, in the order the defs first mention them. */
export function settingGroups(scope: SettingScope): string[] {
  const seen: string[] = []
  for (const def of settingsForScope(scope)) {
    if (!seen.includes(def.group)) seen.push(def.group)
  }
  return seen
}

export function findSetting(key: string): AnySettingDef | undefined {
  return SETTING_DEFS.find((def) => def.key === key)
}

/**
 * Read one setting out of a scope's stored values, falling back to its default.
 *
 * Tolerant on purpose: a value of the wrong type — hand-edited, or written by a
 * build that had a different schema — yields the default rather than throwing,
 * because a single bad preference must not take a project down with it.
 */
export function resolveSetting<D extends SettingDef>(
  def: D,
  stored: Record<string, unknown> | null | undefined
): z.infer<D['schema']> {
  const parsed = def.schema.safeParse(stored?.[def.storageKey])
  if (parsed.success) return parsed.data as z.infer<D['schema']>
  return def.schema.parse(undefined) as z.infer<D['schema']>
}
