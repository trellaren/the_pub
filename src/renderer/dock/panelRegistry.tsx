import type { IDockviewPanelProps } from 'dockview-react'
import type { FunctionComponent } from 'react'
import { FileTree } from '@renderer/panels/explorer/FileTree.js'
import { SearchPanel } from '@renderer/panels/search/SearchPanel.js'
import { EditorPanel } from '@renderer/panels/editor/EditorPanel.js'
import { WelcomePanel } from '@renderer/panels/welcome/WelcomePanel.js'
import { StylesPanel } from '@renderer/panels/styles/StylesPanel.js'

/**
 * Panel type → component. Dockview stores only the string in a saved layout, so
 * these names are a persistence format: renaming one invalidates saved layouts.
 */
export const panelComponents: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  explorer: FileTree as FunctionComponent<IDockviewPanelProps>,
  search: SearchPanel as FunctionComponent<IDockviewPanelProps>,
  editor: EditorPanel as FunctionComponent<IDockviewPanelProps>,
  welcome: WelcomePanel as FunctionComponent<IDockviewPanelProps>,
  styles: StylesPanel as FunctionComponent<IDockviewPanelProps>
}
