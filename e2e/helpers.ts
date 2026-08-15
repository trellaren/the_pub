import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

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
