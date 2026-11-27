import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Share } from '@capacitor/share'
import { Filesystem, Directory } from '@capacitor/filesystem'
import type { HttpRequest, HttpResponse } from '../protocol.js'

/**
 * Everything that differs between the Capacitor shell and a browser tab.
 *
 * The same build runs in both: in the shell these reach native plugins, and in
 * a tab — where the app is developed and tested — each has a web equivalent.
 */

export const isNative = Capacitor.isNativePlatform()

/** The URL scheme registered for the app in `ios/App/App/Info.plist`. */
const NATIVE_REDIRECT = 'quoth://auth'

export function redirectUri(): string {
  return isNative ? NATIVE_REDIRECT : new URL('auth.html', document.baseURI).toString()
}

export async function openExternal(url: string): Promise<void> {
  if (isNative) await Browser.open({ url })
  else window.open(url, '_blank', 'noopener')
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function saveFile(name: string, bytes: Uint8Array): Promise<void> {
  if (isNative) {
    const written = await Filesystem.writeFile({ path: name, data: toBase64(bytes), directory: Directory.Cache })
    await Share.share({ title: name, files: [written.uri] })
    return
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

let cancelSignIn: ((reason: string) => void) | null = null

export function cancelAuthSession(): void {
  cancelSignIn?.('The sign-in was cancelled.')
}

/**
 * Open the sign-in page and resolve with the URL the browser was sent back to.
 *
 * In the shell that arrives as the app being opened through its URL scheme;
 * in a tab, as a message from the page the redirect landed on.
 */
export function authSession(url: string, redirect: string): Promise<{ url: string }> {
  cancelSignIn?.('A newer sign-in replaced this one.')
  return new Promise((resolve, reject) => {
    const cleanups: (() => void)[] = []
    const finish = (settle: () => void): void => {
      cancelSignIn = null
      for (const cleanup of cleanups.splice(0)) cleanup()
      settle()
    }
    cancelSignIn = (reason) => finish(() => reject(new Error(reason)))

    if (isNative) {
      void App.addListener('appUrlOpen', (event) => {
        if (!event.url.startsWith(redirect)) return
        finish(() => resolve({ url: event.url }))
        void Browser.close().catch(() => {})
      }).then((handle) => cleanups.push(() => void handle.remove()))
      // Fires for a close of our own as well, by which time `finish` has run and this is a no-op.
      void Browser.addListener('browserFinished', () => cancelSignIn?.('The sign-in was cancelled.')).then(
        (handle) => cleanups.push(() => void handle.remove())
      )
      void Browser.open({ url }).catch((error: unknown) => cancelSignIn?.(String(error)))
      return
    }

    const popup = window.open(url, '_blank')
    if (!popup) {
      cancelSignIn('The browser blocked the sign-in window.')
      return
    }
    const onMessage = (event: MessageEvent): void => {
      const landed = (event.data as { quothAuthRedirect?: unknown } | null)?.quothAuthRedirect
      if (event.origin !== window.location.origin || typeof landed !== 'string') return
      finish(() => resolve({ url: landed }))
    }
    window.addEventListener('message', onMessage)
    cleanups.push(() => window.removeEventListener('message', onMessage))
    const closed = setInterval(() => {
      if (popup.closed) cancelSignIn?.('The sign-in was cancelled.')
    }, 500)
    cleanups.push(() => clearInterval(closed))
  })
}

const FORM = 'application/x-www-form-urlencoded'

/** A request made by the operating system rather than the page, so CORS does not apply to it. */
export async function nativeHttp(request: HttpRequest): Promise<HttpResponse> {
  const contentType = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
  const response = await CapacitorHttp.request({
    url: request.url,
    method: request.method,
    headers: request.headers,
    // The plugin encodes a form body itself, and only from an object.
    data:
      request.body !== undefined && contentType?.startsWith(FORM)
        ? Object.fromEntries(new URLSearchParams(request.body))
        : request.body,
    responseType: 'arraybuffer',
    disableRedirects: !request.followRedirects
  })
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(response.headers ?? {})) headers[name.toLowerCase()] = String(value)
  return {
    status: response.status,
    headers,
    body: typeof response.data === 'string' ? fromBase64(response.data) : new Uint8Array()
  }
}
