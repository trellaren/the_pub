import type { IpcReq, IpcRes } from '../src/shared/ipc/contract.js'
import type { PubDocument } from '../src/shared/model/document.js'
import type { CslItem } from '../src/shared/model/source.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { unzipSync, strFromU8 } from 'fflate'
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'

export interface Harness {
  app: ElectronApplication
  page: Page
  projectDir: string
  userDataDir: string
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

/**
 * Launch the built app against throwaway project and user-data directories, so
 * tests never inherit state from each other or from a real install.
 *
 * With no `executablePath` this runs the electron-vite output through the dev
 * Electron binary — `'.'` resolves against `cwd` to `package.json`'s `main`.
 * With one, it runs a real packaged artifact instead, which already knows where
 * its own app is and must not be given an app path at all.
 */
export async function launch(
  options: { projectDir?: string; userDataDir?: string; executablePath?: string } = {}
): Promise<Harness> {
  const projectDir = options.projectDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'pub-e2e-project-')))
  const userDataDir = options.userDataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'pub-e2e-userdata-')))

  const app = await electron.launch({
    args: [
      ...(options.executablePath ? [] : ['.']),
      '--no-sandbox',
      `--user-data-dir=${userDataDir}`
    ],
    cwd: REPO_ROOT,
    // Opt in with QUOTH_E2E_HIDDEN=1 to park every test window off-screen and
    // unfocused — the suite launches the app once per test, and on a desktop
    // without a virtual display that is otherwise a window in your face per
    // test. The app reads the flag under its own name so that nothing but the
    // harness can set it by accident.
    env: {
      ...process.env,
      ...(process.env.QUOTH_E2E_HIDDEN === '1' ? { QUOTH_HIDDEN_WINDOWS: '1' } : {}),
      // localtest.me resolves to 127.0.0.1, which the page-fetch address check
      // refuses; fixture pages are served there, so the harness vouches for it.
      QUOTH_E2E_FIXTURE_HOSTS: 'localtest.me',
      // The native save dialog can't be driven, so the harness opts in to the
      // path-taking export channels that production never registers.
      QUOTH_E2E_DIRECT_EXPORT: '1',
      // Likewise for channels that take a local path only from a native picker.
      QUOTH_E2E_TRUST_PATHS: '1'
    },
    ...(options.executablePath ? { executablePath: options.executablePath } : {})
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.__pub))
  return { app, page, projectDir, userDataDir }
}

/** Electron ships these beside the app. None of them is the app. */
const ELECTRON_HELPERS = new Set(['chrome-sandbox', 'chrome_crashpad_handler', 'chrome_crashpad_handler.exe'])

/** Shared libraries carry the executable bit on Linux, and none of them is the app either. */
const SHARED_LIBRARY = /\.(so|dylib|dll)(\.\d+)*$/i

/**
 * The executable `electron-builder --dir` produced, or null when nothing has
 * been packaged yet.
 *
 * Nothing here spells the product out, because two different fields decide the
 * name: Linux takes it from `package.json`'s `name`, Windows and macOS from
 * `productName`. The output directory also gains an architecture suffix on
 * anything but x64. Both are read off disk rather than predicted.
 *
 * A missing `release/` returns null — it is gitignored and absent by default,
 * so the packaged suite can say "package it first" rather than failing with a
 * spawn error naming a path nobody recognises.
 */
export async function packagedExecutable(
  releaseDir = path.join(REPO_ROOT, 'release')
): Promise<string | null> {
  const entries = await fs.readdir(releaseDir, { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)

  if (process.platform === 'darwin') {
    const macDir = dirs.find((name) => name === 'mac' || name.startsWith('mac-'))
    if (!macDir) return null
    const bundle = (await fs.readdir(path.join(releaseDir, macDir))).find((name) => name.endsWith('.app'))
    if (!bundle) return null
    return soleExecutable(path.join(releaseDir, macDir, bundle, 'Contents', 'MacOS'))
  }

  const prefix = process.platform === 'win32' ? 'win' : 'linux'
  const dir = dirs.find(
    (name) => name === `${prefix}-unpacked` || (name.startsWith(`${prefix}-`) && name.endsWith('-unpacked'))
  )
  return dir ? soleExecutable(path.join(releaseDir, dir)) : null
}

/**
 * The one executable in a directory.
 *
 * Refusing to guess when there is more than one is the point: if Electron gains
 * another top-level helper, this says so rather than launching the wrong thing.
 * The executable bit is the test rather than the absence of an extension,
 * because `linux-unpacked` also holds `LICENSE` and `version`, both
 * extensionless and both unexecutable.
 */
async function soleExecutable(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const candidates: string[] = []

  for (const entry of entries) {
    if (!entry.isFile() || ELECTRON_HELPERS.has(entry.name) || SHARED_LIBRARY.test(entry.name)) continue
    if (process.platform === 'win32') {
      if (entry.name.toLowerCase().endsWith('.exe')) candidates.push(entry.name)
    } else {
      const stats = await fs.stat(path.join(dir, entry.name))
      if ((stats.mode & 0o111) !== 0) candidates.push(entry.name)
    }
  }

  if (candidates.length !== 1) {
    throw new Error(`Expected one executable in ${dir}, found: ${candidates.join(', ') || 'none'}`)
  }
  return path.join(dir, candidates[0]!)
}

/** Open a project through the same store action the Welcome screen uses. */
export async function openProject(page: Page, projectDir: string): Promise<void> {
  await page.evaluate((uri) => window.__pub.project.getState().open(uri), projectDir)
  await page.waitForFunction(() => window.__pub.project.getState().project !== null)
}

export async function createDocument(page: Page, docPath: string): Promise<string> {
  const docId = await page.evaluate(async (target) => {
    const documents = window.__pub.documents.getState()
    const id = await documents.create(target)
    if (!id) return null
    const state = window.__pub.documents.getState().docs[id]!
    window.__pub.layout.getState().openEditor(id, state.path, state.title)
    return id
  }, docPath)
  if (!docId) throw new Error(`Could not create ${docPath}`)
  return docId
}

export async function cleanup(harness: Harness): Promise<void> {
  await harness.app.close().catch(() => {})
  await fs.rm(harness.projectDir, { recursive: true, force: true }).catch(() => {})
  await fs.rm(harness.userDataDir, { recursive: true, force: true }).catch(() => {})
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  message: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for: ${message}${lastError ? ` (last error: ${String(lastError)})` : ''}`)
}

type PickerChannel = 'docx:importDialog' | 'fountain:importDialog' | 'sources:importDialog'

/**
 * Import files the way a person does: through the native picker, answered here
 * with `files`. There is deliberately no channel that takes a path from the
 * renderer, so a test cannot skip the dialog either.
 */
export async function importPicked<K extends PickerChannel>(
  harness: Harness,
  channel: K,
  files: string[],
  payload: IpcReq<K>
): Promise<NonNullable<IpcRes<K>>> {
  await harness.app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: chosen })) as typeof dialog.showOpenDialog
  }, files)
  const result = await harness.page.evaluate(
    ([name, body]) => window.pub.invoke(name as K, body as IpcReq<K>),
    [channel, payload] as const
  )
  if (!result) throw new Error(`${channel} returned nothing`)
  return result as NonNullable<IpcRes<K>>
}

/**
 * The editor on screen. Scoped to the visible sheet: a second open document
 * leaves its editor mounted in the hidden dock panel, so an unqualified locator
 * matches both.
 */
export async function editor(page: Page): Promise<Locator> {
  const locator = page.locator('.pub-sheet:visible .ProseMirror').first()
  await expect(locator).toBeVisible()
  return locator
}

/**
 * Replace the document's whole text, leaving the caret at the end.
 *
 * Waits for the typed text to actually land in the DOM before returning —
 * under load, `selectRange`'s first keystroke can otherwise race a still-in-
 * flight keystroke from typing, landing the selection a character or two off
 * from where the test expects it.
 */
export async function setText(page: Page, text: string): Promise<void> {
  const el = await editor(page)
  await el.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(text)
  await expect(el).toContainText(text)
}

/**
 * Select `[start, end)` of the (single-paragraph) document by keyboard.
 *
 * Presses through the locator, not the page-level keyboard: under load, ambient
 * OS focus can slip away between keystrokes (an autosave-triggered re-render is
 * enough), and a `page.keyboard.press` that lands on the wrong element fails
 * silently rather than failing loudly. Re-focusing the editor on every press
 * costs a little time and buys determinism.
 */
export async function selectRange(page: Page, start: number, end: number): Promise<void> {
  const el = await editor(page)
  await el.press('Home')
  for (let i = 0; i < start; i++) await el.press('ArrowRight')
  for (let i = 0; i < end - start; i++) await el.press('Shift+ArrowRight')
}

/**
 * Type into the editor on screen and get it to disk. Flushing before the last
 * keystroke has landed would save a truncated document, so it waits first.
 */
export async function write(page: Page, text: string): Promise<void> {
  const el = await editor(page)
  await el.click()
  await page.keyboard.type(text)
  await expect(el).toContainText(text)
  await page.evaluate(() => window.__pub.documents.getState().flushAll())
}

export async function setStyle(page: Page, styleId: string): Promise<void> {
  await page.locator('select[title="Paragraph style"]:visible').selectOption(styleId)
}

export async function savedDocument(projectDir: string, file: string): Promise<PubDocument> {
  return readJson<PubDocument>(path.join(projectDir, file))
}

export function documentXml(bytes: Uint8Array): string {
  return strFromU8(unzipSync(bytes)['word/document.xml']!)
}

/** Create a source the way the Sources panel does, and return it as stored. */
export async function createSource(page: Page, type: string, fields: Partial<CslItem>): Promise<CslItem> {
  const result = await page.evaluate(
    async ({ type: sourceType, fields: patch }) => {
      const store = window.__pub.sources.getState()
      const source = await store.create(sourceType)
      if (!source) return { error: 'create returned null' }
      window.__pub.sources.getState().patch(source.id, patch)
      await window.__pub.sources.getState().flush()
      const found = window.__pub.sources.getState().sources.find((candidate) => candidate.id === source.id)
      return found ?? { error: 'not found after patch', createdId: source.id }
    },
    { type, fields }
  )
  if ((result as { error?: string }).error) throw new Error(`createSource failed: ${JSON.stringify(result)}`)
  return result as CslItem
}

/** Save a connection profile through the same channel the Connect dialog uses, returning its id. */
export async function saveProfile(
  page: Page,
  profile: IpcReq<'connections:save'>['profile'],
  secret: string
): Promise<string> {
  return page.evaluate(
    async (body) => ((await window.pub.invoke('connections:save', body)) as { id: string }).id,
    { profile, secret }
  )
}
