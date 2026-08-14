import { useEffect, useState } from 'react'
import { DockRoot } from './dock/DockRoot.js'
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
import { invoke, on, onError } from './lib/ipc.js'
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
  const [errors, setErrors] = useState<string[]>([])

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
    return onError((message) => {
      setErrors((current) => [...current.slice(-3), message])
      setTimeout(() => setErrors((current) => current.slice(1)), 6000)
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
      registerCommand({ id: 'document.new', title: 'New Document', run: () => void createDocument() }),
      registerCommand({
        id: 'layout.savePreset',
        title: 'Save Layout As…',
        run: () => {
          const name = window.prompt('Name this layout')
          if (name) void useLayoutStore.getState().savePreset(name)
        }
      })
    ]
    return () => unregister.forEach((dispose) => dispose())
  }, [openDialog, setTheme])

  // Menu items and accelerators arrive as command ids so they run the same code
  // as the palette.
  useEffect(() => {
    return on('command:invoke', ({ commandId }) => {
      runCommand(commandId)
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
      {errors.length > 0 ? (
        <div className="pointer-events-none fixed bottom-3 right-3 z-50 flex flex-col gap-1">
          {errors.map((message, index) => (
            <div
              key={index}
              className="pointer-events-auto max-w-96 rounded border border-danger/50 bg-surface-2 px-3 py-2 text-[12px] text-danger shadow-lg"
            >
              {message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

async function createDocument(): Promise<void> {
  const name = window.prompt('New document name', `untitled${DOC_EXT}`)
  if (!name) return
  const path = name.endsWith(DOC_EXT) ? name : `${name}${DOC_EXT}`
  const docId = await useDocumentStore.getState().create(path)
  if (!docId) return
  const state = useDocumentStore.getState().docs[docId]
  if (state) useLayoutStore.getState().openEditor(docId, state.path, state.title)
}
