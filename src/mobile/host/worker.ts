import './globals.js'
import path from 'node:path'
import { MobileFs, IndexedDbBlobStore, MemoryBlobStore, type BlobStore } from './mobileFs.js'
import { installRuntime, settleShell, shell, current } from './runtime.js'
import { loadStorageKey } from './storageKey.js'
import { initSqlite } from './shims/sqlite.js'
import { installHostFetch } from './network.js'
import { MobileWindows } from './windows.js'
import { DOCUMENTS, EXPORTS, TEMP, USER_DATA, dispatch } from './shims/electron.js'
import { MobileRedirect } from './signIn.js'
import { readAsset } from './assets.js'
import type { HostInit, HostToPage, PageToHost } from '../protocol.js'
import { registerHandlers, SessionRegistry } from '../../main/ipc/registerHandlers.js'
import type { WindowManager } from '../../main/windows/windowManager.js'
import type { ModelStore } from '../../main/llm/modelStore.js'
import type { LlmEngine } from '../../main/llm/engine.js'
import { ConnectionStore } from '../../main/services/connectionStore.js'
import { KnownHostsStore } from '../../main/services/knownHostsStore.js'
import { OneDriveAuth } from '../../main/services/oneDriveAuth.js'
import { setConnectionResolver } from '../../main/vfs/vfsRegistry.js'
import { KnownHostsPolicy } from '../../main/vfs/hostKeys.js'
import { AppStateService } from '../../main/services/appState.js'
import { TemplateService } from '../../main/services/templateService.js'
import { PUB_DIR } from '../../shared/constants.js'

const TEMPLATES = '/resources/templates'

const builtinTemplates = import.meta.glob<string>('../../../resources/templates/**/*', {
  query: '?raw',
  import: 'default',
  eager: true
})

interface WorkerScope {
  postMessage(message: HostToPage, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<PageToHost>) => void) | null
}

const scope = self as unknown as WorkerScope

function post(message: HostToPage, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer)
}

function emit(channel: string, payload: unknown): void {
  post({ type: 'event', channel, payload })
}

/** The search index is opened synchronously wherever it lives, so it is the one project file kept in memory. */
function readSynchronously(file: string): boolean {
  return file.startsWith(`${USER_DATA}/`) || file.endsWith(`/${PUB_DIR}/index.db`)
}

async function openStore(): Promise<BlobStore> {
  try {
    return await IndexedDbBlobStore.open()
  } catch {
    // A private window: the app still works, and forgets everything on close.
    return new MemoryBlobStore()
  }
}

/**
 * An embedded model is a native binary and gigabytes of weights; neither
 * exists here. Reporting "no runtime" is what the desktop app does on a
 * platform it has no binary for, and every caller already handles it.
 */
const noEngine = {
  status: () => ({ state: 'stopped', model: null, url: null, message: '' }),
  available: () => false,
  runningUrl: () => null,
  ensure: async () => null,
  keepAlive: () => {},
  setIdleMs: () => {},
  stop: async () => {}
} as unknown as LlmEngine

const noModels = {
  resolve: () => null,
  resolveSideloaded: () => null,
  status: async () => [],
  download: async () => ({ ok: false, reason: 'unavailable' }),
  cancel: () => {},
  remove: async () => {}
} as unknown as ModelStore

async function start(init: HostInit): Promise<SessionRegistry> {
  const [fs, storageKey] = await Promise.all([
    openStore().then((store) =>
      MobileFs.open(store, { persistent: [USER_DATA, DOCUMENTS], eager: readSynchronously })
    ),
    loadStorageKey(),
    initSqlite()
  ])
  installRuntime({ fs, init, post, storageKey })
  installHostFetch()

  for (const root of [TEMP, EXPORTS, TEMPLATES]) fs.mkdirSync(root, { recursive: true })
  for (const [source, contents] of Object.entries(builtinTemplates)) {
    const target = `${TEMPLATES}/${source.split('/resources/templates/')[1]}`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents)
  }

  const appState = new AppStateService()
  const connections = new ConnectionStore()
  const oneDrive = new OneDriveAuth(connections, undefined, new MobileRedirect(init.redirectUri))
  setConnectionResolver({
    profile: (id) => connections.get(id),
    secret: (id) => connections.secret(id),
    privateKey: () => null,
    oneDriveTokens: (id) => oneDrive.tokenSource(id),
    hostKeys: new KnownHostsPolicy(new KnownHostsStore())
  })

  const sessions = new SessionRegistry()
  registerHandlers({
    windows: new MobileWindows(emit) as unknown as WindowManager,
    sessions,
    appState,
    oneDrive,
    templates: new TemplateService({ builtin: TEMPLATES, user: `${USER_DATA}/templates` }),
    models: noModels,
    engine: noEngine
  })
  appState.onChange((state) => emit('app:stateChanged', state))
  return sessions
}

/**
 * Hand anything a handler exported to the share sheet.
 *
 * A desktop export ends with a file where the save dialog said to put it. Here
 * the dialog names a path under `EXPORTS` without asking, and where the file
 * goes is asked afterwards, by iOS, once there is a file to send.
 */
async function deliverExports(): Promise<void> {
  const fs = current().fs
  for (const folder of fs.readdirSync(EXPORTS)) {
    const dir = `${EXPORTS}/${folder}`
    for (const name of fs.readdirSync(dir)) {
      const bytes = fs.readFileSync(`${dir}/${name}`) as Uint8Array
      if (bytes.byteLength > 0) await shell({ op: 'saveFile', name, bytes }).catch(() => {})
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let starting: Promise<SessionRegistry> | null = null

scope.onmessage = ({ data: message }) => {
  if (message.type === 'init') {
    starting = start(message.init)
    starting.then(
      () => post({ type: 'ready' }),
      (error) => post({ type: 'failed', error: describe(error) })
    )
    return
  }
  if (message.type === 'shellResult') {
    settleShell(message.id, message)
    return
  }
  if (!starting) return

  if (message.type === 'asset') {
    void starting
      .then((sessions) => readAsset(sessions, message.url))
      .catch(() => null)
      .then((asset) =>
        post({ type: 'assetResult', id: message.id, bytes: asset?.bytes ?? null, mime: asset?.mime ?? '' })
      )
    return
  }

  void starting
    .then(() => dispatch(message.channel, message.payload))
    .then(
      async (value) => {
        post({ type: 'result', id: message.id, ok: true, value })
        await deliverExports()
      },
      (error) => post({ type: 'result', id: message.id, ok: false, error: describe(error) })
    )
}
