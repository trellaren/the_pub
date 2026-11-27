import { describe, it, expect, beforeEach } from 'vitest'
import { MobileFs, MemoryBlobStore } from './mobileFs.js'
import { installRuntime, settleShell } from './runtime.js'
import { MobileRedirect } from './signIn.js'
import type { HostToPage, ShellRequest } from '../protocol.js'

let asked: { id: number; request: ShellRequest }[]

beforeEach(async () => {
  asked = []
  installRuntime({
    fs: await MobileFs.open(new MemoryBlobStore(), { persistent: [], eager: () => true }),
    init: { native: true, locale: 'en', version: '0', redirectUri: 'quoth://auth' },
    storageKey: new Uint8Array(32),
    post: (message: HostToPage) => {
      if (message.type === 'shell') asked.push({ id: message.id, request: message.request })
    }
  })
})

describe('MobileRedirect', () => {
  it('asks Microsoft to come back to the app, and resolves with where the browser landed', async () => {
    const catcher = await new MobileRedirect('quoth://auth').listen()
    expect(catcher.redirectUri).toBe('quoth://auth')
    await catcher.open('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1')
    expect(asked[0]!.request).toEqual({
      op: 'authSession',
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1',
      redirectUri: 'quoth://auth'
    })
    settleShell(asked[0]!.id, { ok: true, value: { url: 'quoth://auth?code=abc&state=s' } })
    expect(await catcher.redirect).toBe('quoth://auth?code=abc&state=s')
  })

  it('fails the sign-in with the reason when the browser is closed without finishing', async () => {
    const catcher = await new MobileRedirect('quoth://auth').listen()
    await catcher.open('https://login.microsoftonline.com/x')
    settleShell(asked[0]!.id, { ok: false, error: 'The sign-in was cancelled.' })
    await expect(catcher.redirect).rejects.toThrow('The sign-in was cancelled.')
  })

  it('gives up when told to, and tells the page to stop waiting too', async () => {
    const catcher = await new MobileRedirect('quoth://auth').listen()
    await catcher.open('https://login.microsoftonline.com/x')
    catcher.abort('The sign-in was cancelled.')
    await expect(catcher.redirect).rejects.toThrow('The sign-in was cancelled.')
    expect(asked[1]!.request).toEqual({ op: 'authCancel' })
  })
})
