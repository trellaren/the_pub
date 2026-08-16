import type { IDockviewPanelProps } from 'dockview-react'
import type { FunctionComponent } from 'react'
import { FileTree } from '@renderer/panels/explorer/FileTree.js'
import { SearchPanel } from '@renderer/panels/search/SearchPanel.js'
import { EditorPanel } from '@renderer/panels/editor/EditorPanel.js'
import { WelcomePanel } from '@renderer/panels/welcome/WelcomePanel.js'
import { StylesPanel } from '@renderer/panels/styles/StylesPanel.js'
import { RecordsPanel, CharactersPanel, LocationsPanel } from '@renderer/panels/entities/EntityPanel.js'
import { TimelinePanel } from '@renderer/panels/beats/TimelinePanel.js'
import { StoryboardPanel } from '@renderer/panels/beats/StoryboardPanel.js'
import { MapPanel } from '@renderer/panels/maps/MapPanel.js'
import { AiPanel } from '@renderer/panels/ai/AiPanel.js'
import { ManuscriptPanel } from '@renderer/panels/manuscript/ManuscriptPanel.js'
import { HistoryPanel } from '@renderer/panels/history/HistoryPanel.js'
import { SettingsPanel } from '@renderer/panels/settings/SettingsPanel.js'
import { NotesPanel } from '@renderer/panels/notes/NotesPanel.js'
import { SourcesPanel } from '@renderer/panels/sources/SourcesPanel.js'

/**
 * Panel type → component. Dockview stores only the string in a saved layout, so
 * these names are a persistence format: renaming one invalidates saved layouts.
 */
export const panelComponents: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  explorer: FileTree as FunctionComponent<IDockviewPanelProps>,
  search: SearchPanel as FunctionComponent<IDockviewPanelProps>,
  editor: EditorPanel as FunctionComponent<IDockviewPanelProps>,
  welcome: WelcomePanel as FunctionComponent<IDockviewPanelProps>,
  styles: StylesPanel as FunctionComponent<IDockviewPanelProps>,
  // One component for every kind a project offers, parameterised by the
  // `kind` param a panel is opened with (see `DockRoot.tsx`'s per-kind
  // commands) — a project with five record kinds needs no extra entries here.
  records: RecordsPanel as FunctionComponent<IDockviewPanelProps>,
  // `characters`/`locations` are the pre-Phase-6 ids: kept only so a layout
  // saved by an older build still resolves. See `EntityPanel.tsx`'s comment
  // on these two exports.
  characters: CharactersPanel as FunctionComponent<IDockviewPanelProps>,
  locations: LocationsPanel as FunctionComponent<IDockviewPanelProps>,
  // Two views of one set of beats: chronology and manuscript order.
  timeline: TimelinePanel as FunctionComponent<IDockviewPanelProps>,
  storyboard: StoryboardPanel as FunctionComponent<IDockviewPanelProps>,
  maps: MapPanel as FunctionComponent<IDockviewPanelProps>,
  ai: AiPanel as FunctionComponent<IDockviewPanelProps>,
  manuscript: ManuscriptPanel as FunctionComponent<IDockviewPanelProps>,
  history: HistoryPanel as FunctionComponent<IDockviewPanelProps>,
  settings: SettingsPanel as FunctionComponent<IDockviewPanelProps>,
  notes: NotesPanel as FunctionComponent<IDockviewPanelProps>,
  sources: SourcesPanel as FunctionComponent<IDockviewPanelProps>
}
