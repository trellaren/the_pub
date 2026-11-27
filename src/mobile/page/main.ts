import { startHost } from './bridge.js'
import { installAssetUrls } from './assetUrls.js'
import { mountShell, runShell } from './shell.js'
import { isNative, redirectUri } from './native.js'
import { installLongPress } from './longPress.js'
import './mobile.css'

declare const __APP_VERSION__: string

async function start(): Promise<void> {
  mountShell(document.getElementById('shell')!)
  const host = await startHost(
    { native: isNative, locale: navigator.language, version: __APP_VERSION__, redirectUri: redirectUri() },
    runShell
  )
  installAssetUrls(host)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') host.suspend()
  })
  if (isNative) installLongPress()
  // After the bridge exists: the renderer's stores reach for `window.pub` as they load.
  await import('@renderer/main.js')
}

start().catch((error: unknown) => {
  const message = document.createElement('pre')
  message.style.cssText = 'padding:2rem;white-space:pre-wrap;font:14px system-ui;color:#e9edf3;background:#0b0d10'
  message.textContent = `Quoth could not start.\n\n${error instanceof Error ? error.message : String(error)}`
  document.body.replaceChildren(message)
})
