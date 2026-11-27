import type { BrowserContext, Page, Route } from '@playwright/test'
import { FakeDrive } from '../../src/main/onedrive/fakeDrive.js'
import { GraphClient } from '../../src/main/onedrive/graph.js'
import { OneDriveAdapter } from '../../src/main/vfs/oneDriveAdapter.js'

export const EDITOR = '.pub-sheet:visible .ProseMirror'

export async function openApp(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => Boolean(window.__pub))
}

/** Open a project kept on the device, through the same store action the Welcome screen uses. */
export async function openDeviceProject(page: Page, name: string): Promise<void> {
  await page.evaluate((uri) => window.__pub.project.getState().open(uri), `/Documents/${name}`)
  await page.waitForFunction(() => window.__pub.project.getState().project !== null)
}

export async function createDocument(page: Page, docPath: string): Promise<string> {
  const docId = await page.evaluate(async (target) => {
    const id = await window.__pub.documents.getState().create(target)
    if (!id) return null
    const state = window.__pub.documents.getState().docs[id]!
    window.__pub.layout.getState().openEditor(id, state.path, state.title)
    return id
  }, docPath)
  if (!docId) throw new Error(`Could not create ${docPath}`)
  return docId
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' }

export const ACCOUNT = 'writer@example.com'

/**
 * Stand a OneDrive up behind the two Microsoft hosts the app talks to.
 *
 * The drive is the same in-memory one the adapter's unit tests use, answering
 * over Graph's own URL shapes, so the app under test runs its real sign-in and
 * its real adapter — only the network's far end is ours.
 */
export async function serveOneDrive(context: BrowserContext): Promise<FakeDrive> {
  const drive = new FakeDrive()

  const answer = async (route: Route): Promise<void> => {
    const request = route.request()
    const url = request.url()
    if (url.endsWith('/v1.0/me') || url.includes('/v1.0/me?')) {
      await route.fulfill({ status: 200, headers: CORS, json: { userPrincipalName: ACCOUNT } })
      return
    }
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers())) headers[name.toLowerCase()] = value
    const response = await drive.fetch(url, {
      method: request.method(),
      headers,
      body: request.postDataBuffer() ?? undefined
    })
    await route.fulfill({
      status: response.status,
      headers: CORS,
      body: Buffer.from(await response.arrayBuffer())
    })
  }
  await context.route('https://graph.microsoft.com/**', answer)
  await context.route('https://upload.example/**', answer)

  await context.route('https://login.microsoftonline.com/**/authorize**', async (route) => {
    const asked = new URL(route.request().url()).searchParams
    const back = new URL(asked.get('redirect_uri')!)
    back.searchParams.set('code', 'code-from-microsoft')
    back.searchParams.set('state', asked.get('state')!)
    await route.fulfill({ status: 302, headers: { location: back.toString() } })
  })
  await context.route('https://login.microsoftonline.com/**/token', async (route) => {
    await route.fulfill({
      status: 200,
      headers: CORS,
      json: { access_token: 'access-0', refresh_token: 'refresh-0', expires_in: 3600 }
    })
  })
  return drive
}

/**
 * The desktop app's own OneDrive adapter, in this process, on the same drive.
 *
 * This is the other end of a sync: the class the Windows build opens a
 * OneDrive project with, reading what the iOS build wrote and writing what it
 * must then pick up.
 */
export function desktopAdapter(drive: FakeDrive, remotePath: string): OneDriveAdapter {
  return new OneDriveAdapter({
    remotePath,
    account: ACCOUNT,
    client: new GraphClient({
      tokens: { get: async () => 'access-desktop', invalidate: () => {} },
      fetch: drive.fetch
    })
  })
}
