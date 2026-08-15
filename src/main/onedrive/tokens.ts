import { refreshTokens, isExpired, type Tokens, type Fetcher } from './oauth.js'
import type { TokenSource } from './graph.js'

/**
 * What a profile contributes to a refresh. Deliberately not the profile itself,
 * so this module knows nothing about connections, Electron or encryption.
 */
export interface TokenAccount {
  clientId: string
  tenant: string
  /** Only for the message shown when nobody has signed in yet. */
  name: string
}

export interface TokenStorage {
  account: (profileId: string) => TokenAccount | null
  refreshToken: (profileId: string) => string | null
  storeRefreshToken: (profileId: string, token: string) => void
}

/**
 * Access tokens in memory, refresh tokens in storage.
 *
 * The whole of the difficulty is that Microsoft rotates the refresh token on
 * every use: spending one invalidates it, so the replacement has to be stored
 * before anything else can go wrong, and two callers must never spend the same
 * one. Both of those are handled here, once, rather than at each call site.
 */
export class TokenCache {
  private tokens = new Map<string, Tokens>()
  /** In-flight refreshes, so ten parallel saves cause one refresh, not ten. */
  private pending = new Map<string, Promise<string>>()

  constructor(
    private readonly storage: TokenStorage,
    private readonly fetcher: Fetcher
  ) {}

  /** Record the tokens a fresh sign-in produced. */
  adopt(profileId: string, tokens: Tokens): void {
    this.tokens.set(profileId, tokens)
    this.storage.storeRefreshToken(profileId, tokens.refreshToken)
  }

  async access(profileId: string): Promise<string> {
    const cached = this.tokens.get(profileId)
    if (cached && !isExpired(cached)) return cached.accessToken

    const inFlight = this.pending.get(profileId)
    // Autosave, the search indexer and the file tree all reach the server at
    // once. Without this, each would spend the refresh token the others are
    // about to use, and all but the first would fail.
    if (inFlight) return inFlight

    const refresh = this.refresh(profileId).finally(() => this.pending.delete(profileId))
    this.pending.set(profileId, refresh)
    return refresh
  }

  private async refresh(profileId: string): Promise<string> {
    const account = this.storage.account(profileId)
    if (!account) throw new Error('That saved server no longer exists on this machine.')
    const stored = this.storage.refreshToken(profileId)
    if (!stored) throw new Error(`Sign in to OneDrive for ${account.name} first.`)

    const tokens = await refreshTokens(
      { clientId: account.clientId, tenant: account.tenant, refreshToken: stored },
      this.fetcher
    )
    this.adopt(profileId, tokens)
    return tokens.accessToken
  }

  /** Drop the cached access token; the stored refresh token is untouched. */
  invalidate(profileId: string): void {
    this.tokens.delete(profileId)
  }

  /** Forget everything held in memory for this profile. */
  forget(profileId: string): void {
    this.tokens.delete(profileId)
    this.pending.delete(profileId)
  }

  source(profileId: string): TokenSource {
    return {
      get: () => this.access(profileId),
      invalidate: () => this.invalidate(profileId)
    }
  }
}
