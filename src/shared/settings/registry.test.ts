import { describe, it, expect } from 'vitest'
import {
  SETTING_DEFS,
  buildScopeSchema,
  settingsForScope,
  settingGroups,
  findSetting,
  resolveSetting
} from './registry.js'
import { projectSettingsSchema } from '../model/manifest.js'
import { appStateSchema } from '../model/app.js'
import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS } from '../constants.js'

describe('the settings registry', () => {
  it('gives every setting a unique key and a unique storage key within its scope', () => {
    const keys = SETTING_DEFS.map((def) => def.key)
    expect(new Set(keys).size).toBe(keys.length)

    for (const scope of ['app', 'project'] as const) {
      const storageKeys = settingsForScope(scope).map((def) => def.storageKey)
      expect(new Set(storageKeys).size).toBe(storageKeys.length)
    }
  })

  it('lists groups in the order the defs first mention them', () => {
    expect(settingGroups('project')).toEqual(['Project', 'Page setup', 'Citations'])
    expect(settingGroups('app')).toEqual(['Application', 'AI', 'Writing stats'])
  })

  it('finds a setting by key', () => {
    expect(findSetting('project.page.width')?.storageKey).toBe('pageWidth')
    expect(findSetting('nothing.at.all')).toBeUndefined()
  })
})

/*
 * The point of these: the registry replaced two hand-written schemas, and the
 * files those schemas parse are already on people's disks. A default that
 * shifted here would silently rewrite settings on the next save.
 */
describe('the schemas built from it', () => {
  it('parses an empty project settings object to exactly the old defaults', () => {
    expect(projectSettingsSchema.parse({})).toEqual({
      autosaveDebounceMs: AUTOSAVE_DEBOUNCE_MS,
      autosaveMaxWaitMs: AUTOSAVE_MAX_WAIT_MS,
      snapshotsEnabled: true,
      pageWidth: 612,
      pageHeight: 792,
      pageMarginTop: 72,
      pageMarginBottom: 72,
      pageMarginLeft: 72,
      pageMarginRight: 72,
      defaultStyleId: 'body',
      citationStyleId: 'chicago-author-date'
    })
  })

  it('keeps the project settings bounds that guarded autosave', () => {
    expect(projectSettingsSchema.safeParse({ autosaveDebounceMs: 50 }).success).toBe(false)
    expect(projectSettingsSchema.safeParse({ autosaveDebounceMs: 30_001 }).success).toBe(false)
    expect(projectSettingsSchema.safeParse({ autosaveMaxWaitMs: 499 }).success).toBe(false)
    expect(projectSettingsSchema.safeParse({ autosaveDebounceMs: 1.5 }).success).toBe(false)
  })

  it('still round-trips a stored settings block unchanged', () => {
    const stored = {
      autosaveDebounceMs: 1200,
      autosaveMaxWaitMs: 9000,
      snapshotsEnabled: false,
      pageWidth: 595,
      pageHeight: 842,
      pageMarginTop: 56,
      pageMarginBottom: 42,
      pageMarginLeft: 90,
      pageMarginRight: 56,
      defaultStyleId: 'chapter-body',
      citationStyleId: 'apa'
    }
    expect(projectSettingsSchema.parse(stored)).toEqual(stored)
  })

  it('leaves app state carrying its non-setting fields alongside the settings', () => {
    const state = appStateSchema.parse({ version: '0.1.0', platform: 'linux' })
    expect(state.theme).toBe('dark')
    expect(state.timelineOrientation).toBe('horizontal')
    expect(state.recentProjects).toEqual([])
    expect(state.keybindings).toEqual({})
  })

  it('rejects a theme the registry does not offer', () => {
    expect(appStateSchema.safeParse({ version: '1', platform: 'linux', theme: 'chartreuse' }).success).toBe(
      false
    )
  })

  it('builds a scope schema holding only that scope, keyed as stored', () => {
    expect(Object.keys(buildScopeSchema('app').shape).sort()).toEqual([
      'aiEnabled',
      'embeddedIdleMinutes',
      'statsIdleTimeoutMinutes',
      'theme',
      'timelineOrientation'
    ])
    expect(Object.keys(buildScopeSchema('project').shape)).toContain('pageWidth')
    expect(Object.keys(buildScopeSchema('project').shape)).not.toContain('theme')
  })
})

describe('resolveSetting', () => {
  const pageWidth = findSetting('project.page.width')!
  const snapshots = findSetting('project.snapshots.enabled')!

  it('reads a stored value', () => {
    expect(resolveSetting(pageWidth, { pageWidth: 595 })).toBe(595)
    expect(resolveSetting(snapshots, { snapshotsEnabled: false })).toBe(false)
  })

  it('falls back to the default when the value is missing', () => {
    expect(resolveSetting(pageWidth, {})).toBe(612)
    expect(resolveSetting(pageWidth, null)).toBe(612)
    expect(resolveSetting(pageWidth, undefined)).toBe(612)
  })

  // A hand-edited project.json must not be able to take the panel down.
  it('falls back to the default when the stored value is the wrong type', () => {
    expect(resolveSetting(pageWidth, { pageWidth: 'wide' })).toBe(612)
    expect(resolveSetting(snapshots, { snapshotsEnabled: 'yes' })).toBe(true)
  })
})
