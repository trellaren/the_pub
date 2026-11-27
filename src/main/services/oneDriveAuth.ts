import { shell } from 'electron'
import type { ConnectionStore } from './connectionStore.js'
import {
  createPkcePair,
  createState,
  authorizeUrl,
  parseCallback,
  exchangeCode,
  loopbackRedirectUri,
  type Fetcher
} from '../onedrive/oauth.js'
import { TokenCache } from '../onedrive/tokens.js'
import { listenOnLoopback } from '../onedrive/loopback.js'
import { GraphClient, GRAPH_BASE, type TokenSource } from '../onedrive/graph.js'

/** How long the loopback listener waits for the browser before giving up. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

const CLOSE_PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font:14px system-ui;padding:3rem;text-align:center">
<h1 style="font-size:1.1rem">You are signed in.</h1>
<p>You can close this tab and go back to Quoth.</p>`

const REFUSED_PAGE = `<!doctype html><meta charset="utf-8"><title>Not signed in</title>
<body style="font:14px system-ui;padding:3rem;text-align:center">
<h1 style="font-size:1.1rem">The sign-in did not go through.</h1>
<p>Go back to Quoth, where it says what Microsoft refused.</p>`

/** One sign-in's wait for the browser to come back. */
export interface RedirectCatcher {
  /** What Microsoft is asked to send the browser to, and must match the registration. */
  redirectUri: string
  /** The URL the browser was sent to. */
  redirect: Promise<string>
  open: (url: string) => Promise<void>
  /** Give up on a redirect that is not coming, with something to show for it. */
  abort: (message: string) => void
  close: () => Promise<void>
}

/**
 * How a sign-in reaches a browser and hears back from it. A desktop listens on
 * loopback; a device that cannot is handed the redirect some other way.
 */
export interface SignInBrowser {
  listen: () => Promise<RedirectCatcher>
}

const loopbackBrowser: SignInBrowser = {
  async listen() {
    const listener = await listenOnLoopback({
      page: CLOSE_PAGE,
      failurePage: REFUSED_PAGE,
      timeoutMs: SIGN_IN_TIMEOUT_MS
    })
    return {
      redirectUri: loopbackRedirectUri(listener.port),
      redirect: listener.redirect,
      open: (url) => shell.openExternal(url),
      abort: listener.abort,
      close: listener.close
    }
  }
}

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
  /** Sign-ins still waiting on a browser, so one can be given up on. */
  private readonly waiting = new Map<string, RedirectCatcher>()

  constructor(
    private readonly store: ConnectionStore,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly browser: SignInBrowser = loopbackBrowser
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
    // Pressing sign in again after a redirect that never arrived has to start a
    // fresh attempt rather than queue behind the one still holding a port.
    this.cancel(profileId)
    const listener = await this.browser.listen()
    this.waiting.set(profileId, listener)

    try {
      const { redirectUri } = listener
      await listener.open(
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
      if (this.waiting.get(profileId) === listener) this.waiting.delete(profileId)
      await listener.close()
    }
  }

  /**
   * Stop waiting for a redirect that is not coming.
   *
   * Without this the dialog is held for the whole timeout by a sign-in that has
   * already visibly failed in the browser, which leaves nothing to do about the
   * client id or tenant that caused it.
   */
  cancel(profileId: string): void {
    this.waiting.get(profileId)?.abort('The sign-in was cancelled.')
  }

  /** Forget the tokens without forgetting the server. */
  signOut(profileId: string): void {
    this.cancel(profileId)
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
