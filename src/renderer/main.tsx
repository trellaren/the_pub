import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { useProjectStore } from './stores/projectStore.js'
import { useDocumentStore } from './stores/documentStore.js'
import { useLayoutStore } from './stores/layoutStore.js'
import { useEntityStore } from './stores/entityStore.js'
import { useBeatStore } from './stores/beatStore.js'
import { useMapStore } from './stores/mapStore.js'
import { useChatStore } from './stores/chatStore.js'
import { confirmMentionHere } from './panels/editor/mentionActions.js'
import { openLocation } from './lib/openLocation.js'
import { runCommand } from './commands/registry.js'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Renderer root element is missing')

/*
 * Test hook.
 *
 * End-to-end tests drive the same store actions the UI does. It exists because
 * opening a project goes through the OS folder dialog, which an automated
 * browser context cannot operate; everything here is already reachable by
 * clicking, so it grants a test no capability a user doesn't have.
 */
Object.assign(window, {
  __pub: {
    project: useProjectStore,
    documents: useDocumentStore,
    layout: useLayoutStore,
    entities: useEntityStore,
    beats: useBeatStore,
    maps: useMapStore,
    chats: useChatStore,
    confirmMention: confirmMentionHere,
    openLocation,
    runCommand
  }
})

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
