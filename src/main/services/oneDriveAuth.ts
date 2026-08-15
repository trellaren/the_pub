import http from 'node:http'
import { AddressInfo } from 'node:net'
import { shell } from 'electron'
import type { ConnectionStore } from './connectionStore.js'
import {
  createPkcePair,
  createState,
  authorizeUrl,
  parseCallback,
  exchangeCode,
  type Fetcher
} from '../onedrive/oauth.js'
import { TokenCache } from '../onedrive/tokens.js'
import { GraphClient, GRAPH_BASE, type TokenSource } from '../onedrive/graph.js'

/** How long the loopback listener waits for the browser before giving up. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

const CLOSE_PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font:14px system-ui;padding:3rem;text-align:center">
<h1 style="font-size:1.1rem">You are signed in.</h1>
<p>You can close this tab and go back to The Pub.</p>`

/**
 * Signing in to OneDrive, and keeping what comes of it.
 *
 * The refresh token is stored where the SFTP passwords are — encrypted, in the
 * app's own data directory — and the access token only ever exists in memory.
 * No channel returns either, so the renderer can ask to sign in and can see the
 * account name, and that is all.
 *
 * The sign-in happens in the person's own browser rather than an Electron
 * window. Microsoft blocks embedded browsers for many tenants outright, and the
 * real one is also where their passkey, their password manager and any session
 * they already have live.
 *
 * Everything that survives the sign-in — caching, refreshing, rotation — is in
 * `onedrive/tokens.ts`, which has no Electron in it and is tested directly.
 */
export class OneDriveAuth {
  private readonly cache: TokenCache

  constructor(
    private readonly store: ConnectionStore,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init)
  ) {
    this.cache = new TokenCache(
      {
        account: (id) => {
          const profile = store.get(id)
          return profile
            ? { clientId: profile.clientId, tenant: profile.tenant, name: profile.name }
            : null
        },
        refreshToken: (id) => store.secret(id),
        storeRefreshToken: (id, token) => {
          store.save({ id }, token)
        }
      },
      fetcher
    )
  }

  /**
   * Run the authorization code flow and store the result.
   *
   * The profile is updated here rather than by the caller: a sign-in that
   * succeeded and was not recorded is worse than one that failed, because the
   * author has no way to tell it happened.
   */
  async signIn(profileId: string): Promise<{ account: string }> {
    const profile = this.store.get(profileId)
    if (!profile) throw new Error('That saved server no longer exists on this machine.')
    if (!profile.clientId) {
      throw new Error('Add the Application (client) ID from your Azure app registration first.')
    }
    if (!this.store.secureStorageAvailable()) {
      throw new Error('This system has no secure storage, so a OneDrive sign-in cannot be kept.')
    }

    const { verifier, challenge } = createPkcePair()
    const state = createState()
    const listener = await listen()

    try {
      const redirectUri = `http://localhost:${listener.port}/callback`
      await shell.openExternal(
        authorizeUrl({
          clientId: profile.clientId,
          tenant: profile.tenant,
          redirectUri,
          challenge,
          state
        })
      )

      const code = parseCallback(await listener.redirect, state)
      const tokens = await exchangeCode(
        { clientId: profile.clientId, tenant: profile.tenant, redirectUri, code, verifier },
        this.fetcher
      )

      this.cache.adopt(profileId, tokens)
      // A drive that works but cannot name itself is still a working drive, so
      // a failure here is not a failure to sign in.
      const account = await this.readAccount(profileId).catch(() => '')
      this.store.save({ id: profileId, account })
      return { account }
    } finally {
      await listener.close()
    }
  }

  /** Forget the tokens without forgetting the server. */
  signOut(profileId: string): void {
    this.cache.forget(profileId)
    this.store.save({ id: profileId, account: '' }, '')
  }

  /** A token source an adapter can be built against. */
  tokenSource(profileId: string): TokenSource {
    return this.cache.source(profileId)
  }

  private async readAccount(profileId: string): Promise<string> {
    const client = new GraphClient({ tokens: this.tokenSource(profileId) })
    const me = await client.json<{ userPrincipalName?: string; mail?: string; displayName?: string }>(
      'GET',
      `${GRAPH_BASE}/me?$select=userPrincipalName,mail,displayName`
    )
    return me.userPrincipalName || me.mail || me.displayName || ''
  }
}

interface Listener {
  port: number
  /** The redirect URL the browser was sent to. */
  redirect: Promise<string>
  close: () => Promise<void>
}

/**
 * A loopback listener for the redirect.
 *
 * Microsoft's desktop application platform allows `http://localhost` on any
 * port, which is what lets a desktop app take a redirect without registering a
 * fixed one — and binding to `127.0.0.1` rather than every interface keeps the
 * authorization code on this machine.
 */
async function listen(): Promise<Listener> {
  let settle: (url: string) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const redirect = new Promise<string>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(CLOSE_PAGE)
    if (request.url) settle(request.url)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  // A browser tab that is never returned to would otherwise hold the port and
  // the pending promise for as long as the app runs.
  const timer = setTimeout(() => fail(new Error('The sign-in was not completed.')), SIGN_IN_TIMEOUT_MS)
  timer.unref?.()

  return {
    port: (server.address() as AddressInfo).port,
    redirect,
    close: async () => {
      clearTimeout(timer)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
