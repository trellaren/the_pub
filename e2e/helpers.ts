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

/**
 * Launch the built app against throwaway project and user-data directories, so
 * tests never inherit state from each other or from a real install.
 */
export async function launch(options: { projectDir?: string; userDataDir?: string } = {}): Promise<Harness> {
  const projectDir = options.projectDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'pub-e2e-project-')))
  const userDataDir = options.userDataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'pub-e2e-userdata-')))

  const app = await electron.launch({
    args: ['.', '--no-sandbox', `--user-data-dir=${userDataDir}`],
    cwd: path.resolve(import.meta.dirname, '..')
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.__pub))
  return { app, page, projectDir, userDataDir }
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
