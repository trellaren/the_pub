import { useCallback, useEffect, useMemo } from 'react'
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IWatermarkPanelProps
} from 'dockview-react'
import { panelComponents } from './panelRegistry.js'
import {
  useLayoutStore,
  restoreLayout,
  scheduleLayoutSave,
  EDITOR_PANEL_PREFIX,
  popoutUrl
} from '@renderer/stores/layoutStore.js'
import { useDocumentStore } from '@renderer/stores/documentStore.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { invoke } from '@renderer/lib/ipc.js'
import { registerDocument, unregisterDocument, allDocuments } from '@renderer/lib/documents.js'
import { registerCommand } from '@renderer/commands/registry.js'
import { DEFAULT_ENTITY_KINDS } from '@shared/model/entity.js'

/**
 * The dock. Everything the user sees lives in a panel here, including panels
 * torn out into their own OS windows.
 */
export function DockRoot() {
  const setApi = useLayoutStore((store) => store.setApi)
  const project = useProjectStore((store) => store.project)

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api
      setApi(api)

      // Closing a tab is how a writer closes a document; flush and release it.
      api.onDidRemovePanel((panel) => {
        if (panel.id.startsWith(EDITOR_PANEL_PREFIX)) {
          useDocumentStore.getState().close(panel.id.slice(EDITOR_PANEL_PREFIX.length))
        }
      })

      api.onDidLayoutChange(() => {
        scheduleLayoutSave(api)
        syncPopoutDocuments(api)
      })

      // A group can become a popout by being dragged out, by a command, or by a
      // restored layout, so this is driven off the group list rather than off
      // any one of those paths.
      api.onDidAddGroup(() => syncPopoutDocuments(api))

      restoreLayout(api, null)
    },
    [setApi]
  )

  // A project's own saved arrangement replaces the default once it's open.
  //
  // Keyed on `project.uri`, not on `project` itself: every manifest write —
  // a style edit, a settings change — replaces the whole `project` object in
  // the store with a new reference, and re-running this on each of those
  // would re-fetch the last-*saved* layout and stomp on whatever panel the
  // user opened since (layout saves are debounced, so anything opened within
  // that window would simply vanish again). The project's identity, not its
  // manifest, is what should trigger reloading its layout.
  useEffect(() => {
    if (!project) return
    const api = useLayoutStore.getState().api
    if (!api) return
    let cancelled = false
    void (async () => {
      const file = await invoke('layout:load', {}).catch(() => null)
      if (cancelled || !api) return
      useLayoutStore.setState({ presets: file?.presets ?? [] })
      restoreLayout(api, file?.lastLayout ?? null)
    })()
    return () => {
      cancelled = true
    }
  }, [project?.uri])

  // The kinds this project offers, driven by its manifest (a thesis template
  // ships `interviewee`/`concept`; absent means the fiction defaults). Keyed
  // to a plain string so the effect below only re-runs when the actual list
  // of kinds changes — `project` itself gets a new reference on every
  // manifest write (see the effect above), which would otherwise tear down
  // and rebuild every command in this file on each keystroke in Settings.
  const entityKinds = project?.manifest.entityKinds ?? DEFAULT_ENTITY_KINDS
  const entityKindsKey = useMemo(() => entityKinds.map((def) => def.id).join(','), [entityKinds])

  useEffect(() => {
    const unregister = [
      registerCommand({
        id: 'layout.reset',
        title: 'Reset Layout',
        run: () => useLayoutStore.getState().reset()
      }),
      registerCommand({
        id: 'layout.popout',
        title: 'Move Tab to New Window',
        run: () => useLayoutStore.getState().popoutActiveGroup()
      }),
      registerCommand({
        id: 'panel.explorer',
        title: 'Show Explorer',
        run: () => useLayoutStore.getState().showPanel('explorer', 'Explorer')
      }),
      registerCommand({
        id: 'panel.search',
        title: 'Show Search',
        run: () => useLayoutStore.getState().showPanel('search', 'Search')
      }),
      registerCommand({
        id: 'panel.styles',
        title: 'Show Styles',
        run: () => useLayoutStore.getState().showPanel('styles', 'Styles')
      }),
      ...entityKinds.map((def) =>
        registerCommand({
          id: `panel.records.${def.id}`,
          title: `Show ${def.labelPlural}`,
          run: () =>
            useLayoutStore
              .getState()
              .showPanel('records', def.labelPlural, { panelId: def.id, params: { kind: def.id } })
        })
      ),
      registerCommand({
        id: 'panel.timeline',
        title: 'Show Timeline',
        run: () => useLayoutStore.getState().showPanel('timeline', 'Timeline')
      }),
      registerCommand({
        id: 'panel.storyboard',
        title: 'Show Storyboard',
        run: () => useLayoutStore.getState().showPanel('storyboard', 'Storyboard')
      }),
      registerCommand({
        id: 'panel.history',
        title: 'Show History',
        run: () => useLayoutStore.getState().showPanel('history', 'History')
      }),
      registerCommand({
        id: 'panel.manuscript',
        title: 'Show Manuscript',
        run: () => useLayoutStore.getState().showPanel('manuscript', 'Manuscript')
      }),
      registerCommand({
        id: 'panel.maps',
        title: 'Show Maps',
        run: () => useLayoutStore.getState().showPanel('maps', 'Maps')
      }),
      registerCommand({
        id: 'panel.ai',
        title: 'Show AI',
        run: () => useLayoutStore.getState().showPanel('ai', 'AI')
      }),
      registerCommand({
        id: 'panel.settings',
        title: 'Show Settings',
        run: () => useLayoutStore.getState().showPanel('settings', 'Settings')
      }),
      registerCommand({
        id: 'panel.notes',
        title: 'Show Notes',
        run: () => useLayoutStore.getState().showPanel('notes', 'Notes')
      }),
      registerCommand({
        id: 'panel.sources',
        title: 'Show Sources',
        run: () => useLayoutStore.getState().showPanel('sources', 'Sources')
      }),
      registerCommand({
        id: 'search.focus',
        title: 'Search Project',
        run: () => useLayoutStore.getState().showPanel('search', 'Search')
      })
    ]
    return () => unregister.forEach((dispose) => dispose())
  }, [entityKindsKey])

  return (
    <DockviewReact
      components={panelComponents}
      watermarkComponent={Watermark}
      rightHeaderActionsComponent={GroupActions}
      onReady={onReady}
      defaultRenderer="always"
      popoutUrl={popoutUrl()}
      className="dockview-theme-dark dockview-theme-pub"
    />
  )
}

/**
 * Per-group header controls.
 *
 * The popout button lives here rather than only in the menu because browsers
 * block `window.open` unless it happens during a user gesture — a click on this
 * button is that gesture.
 */
function GroupActions(props: IDockviewHeaderActionsProps) {
  const isPopout = props.group.api.location.type === 'popout'
  return (
    <div className="flex h-full items-center pr-1">
      <button
        type="button"
        title={isPopout ? 'Return group to the main window' : 'Move group to a new window'}
        aria-label={isPopout ? 'Return group to the main window' : 'Move group to a new window'}
        data-testid="popout-group"
        className="pub-focus-ring flex h-6 w-6 items-center justify-center rounded text-[12px] text-faint hover:bg-surface-3 hover:text-text"
        onClick={() => {
          if (isPopout) props.containerApi.addGroup({ referenceGroup: props.group })
          else void props.containerApi.addPopoutGroup(props.group)
        }}
      >
        {isPopout ? '⧈' : '⧉'}
      </button>
    </div>
  )
}

function Watermark(_props: IWatermarkPanelProps) {
  return (
    <div className="flex h-full items-center justify-center text-[12px] text-faint">
      Open a document from the Explorer
    </div>
  )
}

/**
 * Popout windows have their own `document`, which dockview populates by
 * portalling React into it. Registering them makes app-level DOM effects — the
 * theme attribute and the generated style sheet — apply there as well.
 */
function syncPopoutDocuments(api: DockviewApi): void {
  const live = new Set<Document>()
  for (const group of api.groups) {
    const location = group.api.location
    if (location.type !== 'popout') continue
    const popoutDocument = location.getWindow().document
    live.add(popoutDocument)
    registerDocument(popoutDocument)
  }
  for (const known of allDocuments()) {
    if (known !== document && !live.has(known)) unregisterDocument(known)
  }
}
