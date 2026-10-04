import { useEffect, useState } from 'react'
import { DockRoot } from './dock/DockRoot.js'
import { TitleBar } from './chrome/TitleBar.js'
import { cx } from './ui/primitives.js'
import { CommandPalette } from './commands/CommandPalette.js'
import { useAppStore } from './stores/appStore.js'
import { useProjectStore } from './stores/projectStore.js'
import { useDocumentStore } from './stores/documentStore.js'
import { useLayoutStore, restoreLayout } from './stores/layoutStore.js'
import type { DockLayout } from '@shared/model/layout.js'
import { useEntityStore } from './stores/entityStore.js'
import { useSourceStore } from './stores/sourceStore.js'
import { useBeatStore } from './stores/beatStore.js'
import { useMapStore } from './stores/mapStore.js'
import { useChatStore } from './stores/chatStore.js'
import { useStatsStore } from './stores/statsStore.js'
import { flushPendingWrites, resetDocumentScopedStores } from './stores/pendingWrites.js'
import { isRegistered, registerCommand, runCommand } from './commands/registry.js'
import { PromptHost, promptForName } from './ui/PromptDialog.js'
import { invoke, on, onNotice, attempt, reportError, reportNotice, type Notice } from './lib/ipc.js'
import { validateFileName } from '@shared/model/filename.js'
import { registerDocumentEffect, setStyleElement } from './lib/documents.js'
import { generateFontFaceSheet } from './lib/projectFonts.js'
import { generateStyleSheet } from './panels/editor/extensions/namedStyles.js'
import { generateMentionStyleSheet } from './panels/editor/extensions/mention.js'
import { DOC_EXT } from '@shared/constants.js'
import { THEMES } from '@shared/themes.js'
import { NewProjectDialog } from './panels/welcome/NewProjectDialog.js'
import { SaveAsTemplateDialog } from './panels/welcome/SaveAsTemplateDialog.js'

const STYLE_ELEMENT_ID = 'pub-named-styles'
const MENTION_STYLE_ELEMENT_ID = 'pub-mention-colors'
const FONT_STYLE_ELEMENT_ID = 'pub-project-fonts'

export function App() {
  const loadAppState = useAppStore((store) => store.load)
  const setTheme = useAppStore((store) => store.setTheme)
  const openDialog = useProjectStore((store) => store.openDialog)
  const project = useProjectStore((store) => store.project)
  const styles = useProjectStore((store) => store.project?.manifest.styles)
  const defaultStyleId = useProjectStore((store) => store.project?.manifest.settings.defaultStyleId)
  const entities = useEntityStore((store) => store.entities)
  const projectFonts = useProjectStore((store) => store.project?.manifest.fonts)
  const assetToken = useProjectStore((store) => store.project?.assetToken)
  const [palette, setPalette] = useState<'hidden' | 'commands' | 'files' | 'panels'>('hidden')
  // Here rather than in the Welcome panel, because a project can be created
  // from the menu and the palette with no Welcome panel on screen at all.
  const [newProject, setNewProject] = useState(false)
  const [saveTemplate, setSaveTemplate] = useState(false)
  const [notices, setNotices] = useState<ShownNotice[]>([])

  useEffect(() => {
    void loadAppState()
  }, [loadAppState])

  /* Records belong to the open project, so they are (re)loaded with it. */
  useEffect(() => {
    if (!project) return
    resetDocumentScopedStores()
    void useEntityStore.getState().load()
    void useBeatStore.getState().load()
    void useMapStore.getState().load()
    void useChatStore.getState().load()
    void useSourceStore.getState().load()
    void useStatsStore.getState().load()
  }, [project?.root])

  useEffect(() => {
    return on('mentions:changed', () => {
      void useEntityStore.getState().refreshCounts()
    })
  }, [])

  useEffect(() => {
    return onNotice((notice) => {
      const id = nextNoticeId++
      setNotices((current) => [...current.slice(-3), { ...notice, id }])
      // An import summary can name several things that were left behind, so it
      // gets longer to read than a one-line failure.
      setTimeout(() => setNotices((current) => withoutNotice(current, id)), notice.kind === 'info' ? 10_000 : 6000)
    })
  }, [])

  /*
   * Named styles are delivered as a real stylesheet rather than inline styles,
   * which is what lets a style edit re-render every open document at once. It
   * has to be installed in each window, popouts included.
   */
  useEffect(() => {
    const css = styles ? generateStyleSheet(styles, defaultStyleId) : ''
    return registerDocumentEffect((target) => setStyleElement(target, STYLE_ELEMENT_ID, css))
  }, [styles, defaultStyleId])

  /* Mention colours ride the same mechanism, and so reach popouts too. */
  useEffect(() => {
    const css = generateMentionStyleSheet(entities)
    return registerDocumentEffect((target) => setStyleElement(target, MENTION_STYLE_ELEMENT_ID, css))
  }, [entities])

  /* Imported fonts too: a face has to exist in the window that renders it. */
  useEffect(() => {
    const css = projectFonts && assetToken ? generateFontFaceSheet(projectFonts, assetToken) : ''
    return registerDocumentEffect((target) => setStyleElement(target, FONT_STYLE_ELEMENT_ID, css))
  }, [projectFonts, assetToken])

  useEffect(() => {
    const unregister = [
      registerCommand({ id: 'project.open', title: 'Open Folder…', run: () => void openDialog() }),
      registerCommand({
        id: 'project.newFromTemplate',
        title: 'New Project from Template…',
        run: () => setNewProject(true)
      }),
      registerCommand({
        id: 'project.close',
        title: 'Close Project',
        isEnabled: () => useProjectStore.getState().project !== null,
        run: () => void closeProject()
      }),
      registerCommand({
        id: 'project.saveAsTemplate',
        title: 'Save Project as Template…',
        // Nothing to serialise without a project open, and the dialog reads the
        // manifest for its defaults.
        isEnabled: () => useProjectStore.getState().project !== null,
        run: () => setSaveTemplate(true)
      }),
      ...THEMES.map(({ id, label }) =>
        registerCommand({
          id: `app.setTheme.${id}`,
          title: `Theme: ${label}`,
          run: () => void setTheme(id)
        })
      ),
      registerCommand({
        id: 'palette.commands',
        title: 'Command Palette',
        run: () => setPalette('commands')
      }),
      registerCommand({ id: 'palette.quickOpen', title: 'Quick Open', run: () => setPalette('files') }),
      registerCommand({
        id: 'panel.focus',
        title: 'Focus Panel…',
        // Nothing to list without a dock, and the picker would just show
        // "No matches".
        isEnabled: () => useLayoutStore.getState().listOpenPanels().length > 0,
        run: () => setPalette('panels')
      }),
      registerCommand({
        id: 'panel.cycle',
        title: 'Cycle Panel Focus',
        run: () => useLayoutStore.getState().cyclePanelFocus()
      }),
      registerCommand({
        id: 'panel.cycleBack',
        title: 'Cycle Panel Focus Backward',
        run: () => useLayoutStore.getState().cyclePanelFocus(true)
      }),
      registerCommand({
        id: 'document.save',
        title: 'Save',
        run: () => {
          const active = useDocumentStore.getState().activeDocId
          if (active) void useDocumentStore.getState().save(active)
        }
      }),
      registerCommand({
        id: 'document.saveAll',
        title: 'Save All',
        run: () => void useDocumentStore.getState().saveAll()
      }),
      // Priority 0 on purpose: while the Explorer is open it claims these ids
      // and creates with its inline input; these dialogs are the fallback for
      // when it is not.
      registerCommand({ id: 'document.new', title: 'New Document', run: () => void createDocument() }),
      registerCommand({ id: 'folder.new', title: 'New Folder', run: () => void createFolder() }),
      registerCommand({
        id: 'document.import',
        title: 'Import from Word…',
        run: () => void importFromWord()
      }),
      registerCommand({
        id: 'document.export',
        title: 'Export to Word…',
        run: () => void exportToWord()
      }),
      registerCommand({
        id: 'document.importFountain',
        title: 'Import from Fountain…',
        run: () => void importFromFountain()
      }),
      registerCommand({
        id: 'document.exportFountain',
        title: 'Export to Fountain…',
        run: () => void exportToFountain()
      }),
      registerCommand({
        id: 'layout.savePreset',
        title: 'Save Layout As…',
        run: () => {
          void promptForName({ title: 'Save layout as', confirmLabel: 'Save' }).then((name) => {
            if (name) void useLayoutStore.getState().savePreset(name)
          })
        }
      })
    ]
    return () => unregister.forEach((dispose) => dispose())
  }, [openDialog, setTheme])

  // Menu items and accelerators arrive as command ids so they run the same code
  // as the palette.
  useEffect(() => {
    return on('command:invoke', ({ commandId }) => {
      // A menu item naming a command nobody registered is a wiring bug, and
      // swallowing it is how eight dead buttons shipped unnoticed.
      if (!runCommand(commandId) && !isRegistered(commandId)) reportError(`Nothing handles the command "${commandId}"`)
    })
  }, [])

  /*
   * Closing the window must not silently discard the debounce window's worth of
   * typing, so main asks first and waits for this flush.
   */
  useEffect(() => {
    return on('window:requestClose', () => {
      void flushPendingWrites().finally(() => void invoke('window:closeConfirmed', {}))
    })
  }, [])

  useEffect(() => {
    return on('vfs:changed', (events) => {
      const paths = events.filter((event) => event.type === 'change' || event.type === 'unlink').map((event) => event.path)
      if (paths.length > 0) void useDocumentStore.getState().handleExternalChanges(paths)
    })
  }, [])

  return (
    <div className="flex h-full flex-col">
      <TitleBar onSearch={() => setPalette('files')} />
      {project?.readOnly ? <ReadOnlyProjectBar /> : null}
      <div className="min-h-0 flex-1">
        <DockRoot />
      </div>
      {palette !== 'hidden' ? (
        <CommandPalette mode={palette} onClose={() => setPalette('hidden')} />
      ) : null}
      {newProject ? <NewProjectDialog onClose={() => setNewProject(false)} /> : null}
      {saveTemplate ? <SaveAsTemplateDialog onClose={() => setSaveTemplate(false)} /> : null}
      <PromptHost />
      <OpeningOverlay />
      <Notices notices={notices} onDismiss={(id) => setNotices((current) => withoutNotice(current, id))} />
    </div>
  )
}

interface ShownNotice extends Notice {
  id: number
}

let nextNoticeId = 0

function withoutNotice<T extends { id: number }>(notices: T[], id: number): T[] {
  return notices.filter((notice) => notice.id !== id)
}

/**
 * The live regions are always mounted, even when empty: a screen reader only
 * announces text added to a region it already knows about. Errors go in an
 * assertive one so they interrupt; everything else waits its turn.
 */
function Notices({ notices, onDismiss }: { notices: ShownNotice[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-50 flex flex-col gap-1">
      {(['error', 'info'] as const).map((kind) => (
        <div key={kind} role={kind === 'error' ? 'alert' : 'status'} aria-live={kind === 'error' ? 'assertive' : 'polite'} className="flex flex-col gap-1">
          {notices
            .filter((notice) => notice.kind === kind)
            .map((notice) => (
              <div
                key={notice.id}
                data-testid={`notice-${notice.kind}`}
                className={cx(
                  'pointer-events-auto flex max-w-96 items-start gap-2 rounded border bg-surface-2 px-3 py-2 text-[12px] shadow-lg',
                  notice.kind === 'error' ? 'border-danger/50 text-danger' : 'border-border text-text'
                )}
              >
                <span className="min-w-0 flex-1">{notice.message}</span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => onDismiss(notice.id)}
                  className="-mr-1 shrink-0 rounded px-1 text-faint hover:text-text"
                  data-testid="notice-dismiss"
                >
                  ×
                </button>
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Opening a remote project can take seconds; without this the window looks
 * idle, and a second click on a recent row would queue another open behind it.
 */
function OpeningOverlay() {
  const opening = useProjectStore((store) => store.opening)
  const name = useProjectStore((store) => store.openingName)
  if (!opening) return null
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      role="status"
      aria-live="polite"
      data-testid="project-opening"
    >
      <div className="rounded border border-border bg-surface px-4 py-3 text-[13px] text-text shadow-lg">
        {name ? `Opening ${name}…` : 'Opening project…'}
      </div>
    </div>
  )
}

/**
 * This project's manifest was written by a newer version of Quoth.
 *
 * It still opened — refusing outright would strand someone who only wants to
 * read — but nothing here may write the manifest back, since this build's
 * schema cannot be trusted to round-trip a shape it doesn't fully know.
 */
function ReadOnlyProjectBar() {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[12px]">
      <span className="text-danger">
        This project was last saved by a newer version of Quoth. It's open read-only until you
        upgrade — styles and settings can't be changed here.
      </span>
    </div>
  )
}

/**
 * Bring Word documents in.
 *
 * The result is reported even when nothing went wrong, because "it worked" and
 * "it worked but the footnotes are gone" look identical in the file tree, and
 * only one of them is what the author expected.
 */
async function importFromWord(): Promise<void> {
  const result = await attempt(invoke('docx:importDialog', { targetDir: '' }), 'Could not import')
  if (!result) return
  const opened = result.imported[0]
  if (opened) {
    const docId = await useDocumentStore.getState().openPath(opened.path)
    if (docId) {
      // Read the store again after the await: the snapshot from before it does
      // not have the document that was just opened.
      const state = useDocumentStore.getState().docs[docId]
      if (state) useLayoutStore.getState().openEditor(docId, state.path, state.title)
    }
  }
  const count = result.imported.length
  const summary = [
    `Imported ${count} document${count === 1 ? '' : 's'}.`,
    result.stylesAdded > 0
      ? `${result.stylesAdded} new style${result.stylesAdded === 1 ? '' : 's'} added.`
      : '',
    ...result.warnings
  ].filter(Boolean)
  reportNotice(summary.join(' '))
}

/** Write the open document out. Nothing open means nothing to export. */
async function exportToWord(): Promise<void> {
  const documents = useDocumentStore.getState()
  const active = documents.activeDocId
  const path = active ? documents.docs[active]?.path : undefined
  if (!path) {
    reportError('Open a document to export it.')
    return
  }
  const result = await attempt(
    invoke('docx:exportDialog', { paths: [path], items: [] }),
    'Could not export'
  )
  if (result) reportNotice(`Exported to ${result.file}`)
}

/** Bring a `.fountain` screenplay in — see `importFromWord`'s reasoning. */
async function importFromFountain(): Promise<void> {
  const result = await attempt(invoke('fountain:importDialog', { targetDir: '' }), 'Could not import')
  if (!result) return
  const opened = result.imported[0]
  if (opened) {
    const docId = await useDocumentStore.getState().openPath(opened.path)
    if (docId) {
      const state = useDocumentStore.getState().docs[docId]
      if (state) useLayoutStore.getState().openEditor(docId, state.path, state.title)
    }
  }
  const count = result.imported.length
  const summary = [`Imported ${count} document${count === 1 ? '' : 's'}.`, ...result.warnings].filter(Boolean)
  reportNotice(summary.join(' '))
}

/** Write the open document out as `.fountain`. Nothing open means nothing to export. */
async function exportToFountain(): Promise<void> {
  const documents = useDocumentStore.getState()
  const active = documents.activeDocId
  const path = active ? documents.docs[active]?.path : undefined
  if (!path) {
    reportError('Open a document to export it.')
    return
  }
  const result = await attempt(invoke('fountain:exportDialog', { path }), 'Could not export')
  if (result) reportNotice(`Exported to ${result.file}`)
}

/**
 * Back to Welcome with nothing open. Pending edits and the arrangement are
 * written first, while there is still a session for them to reach.
 */
async function closeProject(): Promise<void> {
  if (!useProjectStore.getState().project) return
  await flushPendingWrites()
  const api = useLayoutStore.getState().api
  if (api) {
    await attempt(
      invoke('layout:saveLast', { layout: api.toJSON() as unknown as DockLayout }),
      'Could not save the layout'
    )
  }
  const closed = await attempt(invoke('project:close', {}), 'Could not close the project')
  if (!closed) return
  useProjectStore.setState({ project: null })
  if (api) restoreLayout(api, null)
  resetDocumentScopedStores()
  useDocumentStore.setState(useDocumentStore.getInitialState(), true)
  useEntityStore.setState(useEntityStore.getInitialState(), true)
  useBeatStore.setState(useBeatStore.getInitialState(), true)
  useMapStore.setState(useMapStore.getInitialState(), true)
  useSourceStore.setState(useSourceStore.getInitialState(), true)
}

async function createDocument(): Promise<void> {
  const name = await promptForName({
    title: 'New document',
    defaultValue: `untitled${DOC_EXT}`,
    // Refused in the dialog, where the name can be fixed, rather than as an
    // error toast after it has closed and taken the typing with it.
    validate: (value) => {
      const checked = validateFileName(value)
      return checked.ok ? null : checked.reason
    }
  })
  if (!name) return
  const path = name.endsWith(DOC_EXT) ? name : `${name}${DOC_EXT}`
  const docId = await useDocumentStore.getState().create(path)
  if (!docId) return
  const state = useDocumentStore.getState().docs[docId]
  if (state) useLayoutStore.getState().openEditor(docId, state.path, state.title)
}

async function createFolder(): Promise<void> {
  const name = await promptForName({
    title: 'New folder',
    defaultValue: 'new-folder',
    validate: (value) => {
      const checked = validateFileName(value)
      return checked.ok ? null : checked.reason
    }
  })
  if (!name) return
  await attempt(invoke('vfs:mkdir', { path: name }), 'Could not create folder')
}
