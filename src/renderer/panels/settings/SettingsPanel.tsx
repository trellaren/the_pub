import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useAppStore } from '@renderer/stores/appStore.js'
import {
  PanelShell,
  PanelHeader,
  EmptyState,
  Select,
  NumberField,
  TextInput,
  Checkbox,
  Field,
  SectionTitle
} from '@renderer/ui/primitives.js'
import {
  settingsForScope,
  settingGroups,
  resolveSetting,
  type SettingDef,
  type SettingScope
} from '@shared/settings/registry.js'
import { keybindableCommands } from '@shared/menu/menuModel.js'
import { resolveAccelerator } from '@shared/menu/keybindings.js'
import { ShortcutField } from './ShortcutField.js'

/**
 * Preferences, in one place.
 *
 * The controls are generated from the settings registry rather than written out
 * one by one: a setting used to have to be added here as well as to the schema,
 * and one that reached only the schema was editable by nobody. The exceptions
 * are the two things the registry cannot know — the project's own named styles,
 * and the keyboard shortcuts, which come from the menu model instead.
 */
export function SettingsPanel() {
  const project = useProjectStore((store) => store.project)
  const updateManifest = useProjectStore((store) => store.updateManifest)
  const appState = useAppStore((store) => store.state)
  const setKeybinding = useAppStore((store) => store.setKeybinding)
  const resetKeybindings = useAppStore((store) => store.resetKeybindings)

  const patchProject = (storageKey: string, value: unknown): void => {
    void updateManifest((manifest) => ({
      ...manifest,
      settings: { ...manifest.settings, [storageKey]: value }
    }))
  }

  const patchApp = (storageKey: string, value: unknown): void => {
    // Each app setting has a channel of its own rather than a generic setter:
    // main validates them by name, and a `set(key, value)` channel would be a
    // way to write anything at all into app state from the renderer.
    const store = useAppStore.getState()
    if (storageKey === 'theme') void store.setTheme(value as never)
    else if (storageKey === 'timelineOrientation') void store.setTimelineOrientation(value as never)
    else if (storageKey === 'aiEnabled') void store.setAiEnabled(value as boolean)
    else if (storageKey === 'embeddedIdleMinutes') void store.setEmbeddedIdleMinutes(value as number)
  }

  const readOnly = project?.readOnly ?? false
  const settings = project?.manifest.settings
  const overrides = appState?.keybindings ?? {}
  const bindings = keybindableCommands()

  const renderControl = (def: SettingDef, scope: SettingScope): React.ReactNode => {
    const stored = (scope === 'app' ? appState : settings) as Record<string, unknown> | undefined
    const value = resolveSetting(def, stored)
    const disabled = scope === 'project' && readOnly
    const commit = (next: unknown): void => {
      if (disabled) return
      if (scope === 'app') patchApp(def.storageKey, next)
      else patchProject(def.storageKey, next)
    }

    if (def.control.kind === 'boolean') {
      return (
        <Checkbox
          key={def.key}
          label={def.title}
          checked={value as boolean}
          onChange={(checked) => commit(checked)}
        />
      )
    }

    if (def.control.kind === 'number') {
      return (
        <NumberField
          key={def.key}
          label={def.title}
          step={def.control.step}
          value={value as number}
          onChange={(next) => next !== undefined && commit(next)}
        />
      )
    }

    if (def.control.kind === 'text') {
      return (
        <Field key={def.key} label={def.title}>
          <TextInput
            value={value as string}
            disabled={disabled}
            onChange={(event) => commit(event.target.value)}
          />
        </Field>
      )
    }

    // A datalist rather than a `<select>`: the listed options are suggestions,
    // and the schema behind a combo setting accepts any string.
    if (def.control.kind === 'combo') {
      const listId = `setting-options-${def.key.replace(/\./g, '-')}`
      return (
        <Field key={def.key} label={def.title}>
          <TextInput
            value={value as string}
            list={listId}
            disabled={disabled}
            onChange={(event) => commit(event.target.value)}
          />
          <datalist id={listId}>
            {def.control.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </datalist>
          {def.description ? (
            <span className="text-[11px] text-faint">{def.description}</span>
          ) : null}
        </Field>
      )
    }

    const options =
      'options' in def.control
        ? def.control.options
        : (project?.manifest.styles ?? []).map((style) => ({ value: style.id, label: style.name }))

    return (
      <Field key={def.key} label={def.title}>
        <Select value={value as string} onChange={(event) => commit(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
    )
  }

  const renderScope = (scope: SettingScope): React.ReactNode =>
    settingGroups(scope).map((group) => (
      <div key={`${scope}:${group}`}>
        <SectionTitle>{group}</SectionTitle>
        {settingsForScope(scope)
          .filter((def) => def.group === group)
          .map((def) => renderControl(def, scope))}
      </div>
    ))

  return (
    <PanelShell>
      <PanelHeader>Settings</PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {appState ? renderScope('app') : <EmptyState title="Loading…" />}

        {!project ? (
          <>
            <SectionTitle>Project</SectionTitle>
            <EmptyState title="No project open" />
          </>
        ) : !settings ? null : (
          <>
            {readOnly ? (
              <p className="mt-4 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[12px] text-danger">
                This project is read-only — it was last saved by a newer version of The Pub, so
                these can&apos;t be changed here.
              </p>
            ) : null}
            {renderScope('project')}
          </>
        )}

        <SectionTitle>Keyboard shortcuts</SectionTitle>
        <p className="mb-2 text-[11px] text-faint">
          Click a shortcut, then press the combination you want. Escape cancels.
        </p>
        {bindings.map((binding) => (
          <ShortcutField
            key={binding.commandId}
            binding={binding}
            accelerator={resolveAccelerator(binding, overrides)}
            isOverridden={overrides[binding.commandId] !== undefined}
            onBind={(accelerator) => setKeybinding(binding.commandId, accelerator)}
          />
        ))}
        <button
          type="button"
          className="pub-focus-ring mt-1 h-7 rounded border border-border px-2 text-[12px] text-muted hover:border-faint hover:text-text disabled:opacity-40"
          disabled={Object.keys(overrides).length === 0}
          onClick={() => void resetKeybindings()}
        >
          Reset all shortcuts
        </button>
      </div>
    </PanelShell>
  )
}
