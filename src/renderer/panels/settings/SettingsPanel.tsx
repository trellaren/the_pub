import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useAppStore } from '@renderer/stores/appStore.js'
import {
  PanelShell,
  PanelHeader,
  EmptyState,
  Select,
  NumberField,
  Checkbox,
  Field,
  SectionTitle
} from '@renderer/ui/primitives.js'
import { THEMES } from '@shared/themes.js'
import type { ProjectSettings } from '@shared/model/manifest.js'
import type { AppState } from '@shared/model/app.js'

/**
 * Preferences, in one place.
 *
 * Project settings previously lived only in `.thepub/project.json`, edited by
 * hand or not at all; application settings had a menu entry per value
 * (`Theme ▸ …`) and nowhere to see the rest. Both come from the same manifest
 * and app-state model this panel already reads elsewhere — nothing new is
 * introduced here except a place to see and change them.
 */
export function SettingsPanel() {
  const project = useProjectStore((store) => store.project)
  const updateManifest = useProjectStore((store) => store.updateManifest)
  const appState = useAppStore((store) => store.state)
  const setTheme = useAppStore((store) => store.setTheme)
  const setTimelineOrientation = useAppStore((store) => store.setTimelineOrientation)

  const patchSettings = (changes: Partial<ProjectSettings>): void => {
    void updateManifest((manifest) => ({
      ...manifest,
      settings: { ...manifest.settings, ...changes }
    }))
  }

  const settings = project?.manifest.settings
  const readOnly = project?.readOnly ?? false

  return (
    <PanelShell>
      <PanelHeader>Settings</PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <SectionTitle>Application</SectionTitle>
        {appState ? (
          <>
            <Field label="Theme">
              <Select
                value={appState.theme}
                onChange={(event) => void setTheme(event.target.value as AppState['theme'])}
              >
                {THEMES.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Timeline orientation">
              <Select
                value={appState.timelineOrientation}
                onChange={(event) =>
                  void setTimelineOrientation(event.target.value as AppState['timelineOrientation'])
                }
              >
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
              </Select>
            </Field>
          </>
        ) : (
          <EmptyState title="Loading…" />
        )}

        <SectionTitle>Project</SectionTitle>
        {!project ? (
          <EmptyState title="No project open" />
        ) : !settings ? null : (
          <>
            {readOnly ? (
              <p className="mb-3 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[12px] text-danger">
                This project is read-only — it was last saved by a newer version of The Pub, so
                these can&apos;t be changed here.
              </p>
            ) : null}

            <NumberField
              label="Autosave delay (ms)"
              step={100}
              value={settings.autosaveDebounceMs}
              onChange={(value) => value !== undefined && !readOnly && patchSettings({ autosaveDebounceMs: value })}
            />
            <NumberField
              label="Autosave maximum wait (ms)"
              step={500}
              value={settings.autosaveMaxWaitMs}
              onChange={(value) => value !== undefined && !readOnly && patchSettings({ autosaveMaxWaitMs: value })}
            />
            <Checkbox
              label="Keep version history"
              checked={settings.snapshotsEnabled}
              onChange={(checked) => !readOnly && patchSettings({ snapshotsEnabled: checked })}
            />

            <SectionTitle>Page setup</SectionTitle>
            <NumberField
              label="Page width (pt)"
              value={settings.pageWidth}
              onChange={(value) => value !== undefined && !readOnly && patchSettings({ pageWidth: value })}
            />
            <NumberField
              label="Page height (pt)"
              value={settings.pageHeight}
              onChange={(value) => value !== undefined && !readOnly && patchSettings({ pageHeight: value })}
            />
            <NumberField
              label="Margin (pt)"
              value={settings.pageMargin}
              onChange={(value) => value !== undefined && !readOnly && patchSettings({ pageMargin: value })}
            />

            <Field label="Default style">
              <Select
                value={settings.defaultStyleId}
                onChange={(event) => !readOnly && patchSettings({ defaultStyleId: event.target.value })}
              >
                {project.manifest.styles.map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
      </div>
    </PanelShell>
  )
}
