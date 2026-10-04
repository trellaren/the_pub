import { beforeEach, describe, expect, it } from 'vitest'
import { usePanelSelectionStore } from './panelSelectionStore.js'
import { useProjectStore } from './projectStore.js'
import type { OpenProject } from '@shared/model/manifest.js'

function openProject(uri: string): void {
  useProjectStore.setState({ project: { uri } as OpenProject })
}

describe('panelSelectionStore', () => {
  beforeEach(() => {
    useProjectStore.setState({ project: null })
    usePanelSelectionStore.getState().clear()
  })

  it('keeps each panel’s selection under its own key', () => {
    const { select } = usePanelSelectionStore.getState()
    select('storyboard.beat', 'b1')
    select('records.character', 'c1')
    expect(usePanelSelectionStore.getState().selections).toEqual({
      'storyboard.beat': 'b1',
      'records.character': 'c1'
    })
  })

  it('survives saving and reloading the same project’s manifest', () => {
    openProject('file:///a')
    usePanelSelectionStore.getState().select('maps.shape', 's1')
    openProject('file:///a')
    expect(usePanelSelectionStore.getState().selections['maps.shape']).toBe('s1')
  })

  it('is cleared when a different project opens, since its ids mean nothing there', () => {
    openProject('file:///a')
    usePanelSelectionStore.getState().select('maps.shape', 's1')
    openProject('file:///b')
    expect(usePanelSelectionStore.getState().selections).toEqual({})
  })
})
