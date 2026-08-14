import type { IDockviewPanelProps } from 'dockview-react'
import type { FunctionComponent } from 'react'
import { FileTree } from '@renderer/panels/explorer/FileTree.js'
import { SearchPanel } from '@renderer/panels/search/SearchPanel.js'
import { EditorPanel } from '@renderer/panels/editor/EditorPanel.js'
import { WelcomePanel } from '@renderer/panels/welcome/WelcomePanel.js'
import { StylesPanel } from '@renderer/panels/styles/StylesPanel.js'
import { CharactersPanel, LocationsPanel } from '@renderer/panels/entities/EntityPanel.js'

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
  // Two keys, one component: `showPanel` takes no parameters, so a pair of
  // one-line wrappers is the honest way to give each kind its own panel.
  characters: CharactersPanel as FunctionComponent<IDockviewPanelProps>,
  locations: LocationsPanel as FunctionComponent<IDockviewPanelProps>
}
