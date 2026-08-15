import { useEffect, useState } from 'react'
import { DockRoot } from './dock/DockRoot.js'
import { cx } from './ui/primitives.js'
import { CommandPalette } from './commands/CommandPalette.js'
import { useAppStore } from './stores/appStore.js'
import { useProjectStore } from './stores/projectStore.js'
import { useDocumentStore } from './stores/documentStore.js'
import { useLayoutStore } from './stores/layoutStore.js'
import { useEntityStore } from './stores/entityStore.js'
import { useBeatStore } from './stores/beatStore.js'
import { useMapStore } from './stores/mapStore.js'
import { useChatStore } from './stores/chatStore.js'
import { registerCommand, runCommand } from './commands/registry.js'
import { PromptHost, promptForName } from './ui/PromptDialog.js'
import { invoke, on, onNotice, attempt, reportError, reportNotice, type Notice } from './lib/ipc.js'
import { validateFileName } from '@shared/model/filename.js'
import { registerDocumentEffect, setStyleElement } from './lib/documents.js'
import { generateStyleSheet } from './panels/editor/extensions/namedStyles.js'
import { generateMentionStyleSheet } from './panels/editor/extensions/mention.js'
import { DOC_EXT } from '@shared/constants.js'
import { THEMES } from '@shared/themes.js'

const STYLE_ELEMENT_ID = 'pub-named-styles'
const MENTION_STYLE_ELEMENT_ID = 'pub-mention-colors'

export function App() {
  const loadAppState = useAppStore((store) => store.load)
  const setTheme = useAppStore((store) => store.setTheme)
  const openDialog = useProjectStore((store) => store.openDialog)
  const project = useProjectStore((store) => store.project)
  const styles = useProjectStore((store) => store.project?.manifest.styles)
  const defaultStyleId = useProjectStore((store) => store.project?.manifest.settings.defaultStyleId)
  const entities = useEntityStore((store) => store.entities)
  const [palette, setPalette] = useState<'hidden' | 'commands' | 'files'>('hidden')
  const [notices, setNotices] = useState<Notice[]>([])

  useEffect(() => {
    void loadAppState()
  }, [loadAppState])

  /* Records belong to the open project, so they are (re)loaded with it. */
  useEffect(() => {
    if (!project) return
    void useEntityStore.getState().load()
    void useBeatStore.getState().load()
    void useMapStore.getState().load()
    void useChatStore.getState().load()
  }, [project?.root])

  useEffect(() => {
    return on('mentions:changed', () => {
      void useEntityStore.getState().refreshCounts()
    })
  }, [])

  useEffect(() => {
    return onNotice((notice) => {
      setNotices((current) => [...current.slice(-3), notice])
      // An import summary can name several things that were left behind, so it
      // gets longer to read than a one-line failure.
      setTimeout(() => setNotices((current) => current.slice(1)), notice.kind === 'info' ? 10_000 : 6000)
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

  useEffect(() => {
    const unregister = [
      registerCommand({ id: 'project.open', title: 'Open Folder…', run: () => void openDialog() }),
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
      if (!runCommand(commandId)) reportError(`Nothing handles the command "${commandId}"`)
    })
  }, [])

  /*
   * Closing the window must not silently discard the debounce window's worth of
   * typing, so main asks first and waits for this flush.
   */
  useEffect(() => {
    return on('window:requestClose', () => {
      void Promise.all([
        useDocumentStore.getState().flushAll(),
        // Record edits are debounced the same way typing is, and are just as
        // easy to lose on the way out.
        useEntityStore.getState().flush(),
        useBeatStore.getState().flush(),
        useMapStore.getState().flush()
      ]).finally(() => void invoke('window:closeConfirmed', {}))
    })
  }, [])

  useEffect(() => {
    return on('vfs:changed', (events) => {
      const paths = events.filter((event) => event.type === 'change' || event.type === 'unlink').map((event) => event.path)
      if (paths.length > 0) void useDocumentStore.getState().handleExternalChanges(paths)
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setPalette('commands')
      } else if (modifier && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setPalette('files')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <DockRoot />
      </div>
      {palette !== 'hidden' ? (
        <CommandPalette mode={palette} onClose={() => setPalette('hidden')} />
      ) : null}
      <PromptHost />
      {notices.length > 0 ? (
        <div className="pointer-events-none fixed bottom-3 right-3 z-50 flex flex-col gap-1">
          {notices.map((notice, index) => (
            <div
              key={index}
              data-testid={`notice-${notice.kind}`}
              className={cx(
                'pointer-events-auto max-w-96 rounded border bg-surface-2 px-3 py-2 text-[12px] shadow-lg',
                notice.kind === 'error'
                  ? 'border-danger/50 text-danger'
                  : 'border-border text-text'
              )}
            >
              {notice.message}
            </div>
          ))}
        </div>
      ) : null}
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
  const result = await attempt(invoke('docx:exportDialog', { paths: [path] }), 'Could not export')
  if (result) reportNotice(`Exported to ${result.file}`)
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
