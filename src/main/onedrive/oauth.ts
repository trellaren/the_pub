import { randomBytes, createHash } from 'node:crypto'

/**
 * The OAuth half of the OneDrive backend: pure, injectable, and testable.
 *
 * Nothing here opens a window or touches Electron. The interactive part —
 * a browser and a loopback listener — lives in `services/oneDriveAuth.ts`, so
 * everything that can be checked without a Microsoft account is checked.
 */

/**
 * What the app asks for, and nothing more.
 *
 * `Files.ReadWrite` is the whole drive the person signs in with; there is no
 * narrower scope for "one folder", so the folder is chosen in the app instead.
 * `offline_access` is what makes a refresh token come back — without it the
 * author would be signing in again every hour. `User.Read` is only so the
 * account can be named back to them; nothing else reads it.
 */
export const GRAPH_SCOPES = ['offline_access', 'Files.ReadWrite', 'User.Read'] as const

/** Refresh this far ahead of expiry, so a slow upload cannot start on a token that dies mid-flight. */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000

export interface Tokens {
  accessToken: string
  /** Microsoft rotates this on every refresh, so the caller must store what comes back. */
  refreshToken: string
  /** Epoch milliseconds. */
  expiresAt: number
}

export interface PkcePair {
  verifier: string
  challenge: string
}

/**
 * A PKCE verifier and its challenge.
 *
 * A desktop app cannot keep a client secret, so the authorization code is bound
 * to a secret generated per sign-in instead: an attacker who intercepts the
 * redirect gets a code they cannot spend.
 */
export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** A one-off value tying a redirect back to the sign-in that started it. */
export function createState(): string {
  return base64Url(randomBytes(16))
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

function authority(tenant: string): string {
  // An empty tenant would silently build a URL against a host called
  // "login.microsoftonline.com//oauth2", which fails with nothing to act on.
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant || 'common')}`
}

export function tokenUrl(tenant: string): string {
  return `${authority(tenant)}/oauth2/v2.0/token`
}

export interface AuthorizeRequest {
  clientId: string
  tenant: string
  redirectUri: string
  challenge: string
  state: string
}

export function authorizeUrl(request: AuthorizeRequest): string {
  const query = new URLSearchParams({
    client_id: request.clientId,
    response_type: 'code',
    redirect_uri: request.redirectUri,
    response_mode: 'query',
    scope: GRAPH_SCOPES.join(' '),
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: 'S256',
    // Show the account picker rather than silently reusing whichever account
    // the browser is already signed in as, which is rarely the one wanted.
    prompt: 'select_account'
  })
  return `${authority(request.tenant)}/oauth2/v2.0/authorize?${query.toString()}`
}

/**
 * Read the authorization code out of the redirect the browser was sent to.
 *
 * Throws rather than returning null: every failure here has a cause the author
 * can act on, and Microsoft's `error_description` names it precisely.
 */
export function parseCallback(url: string, expectedState: string): string {
  let params: URLSearchParams
  try {
    params = new URL(url, 'http://localhost').searchParams
  } catch {
    throw new Error('The sign-in redirect could not be read.')
  }

  const error = params.get('error')
  if (error) throw new Error(params.get('error_description') || error)

  const state = params.get('state')
  // A redirect that does not carry this sign-in's state is either stale or
  // forged, and spending its code would be spending someone else's.
  if (state !== expectedState) throw new Error('The sign-in redirect did not match this attempt.')

  const code = params.get('code')
  if (!code) throw new Error('The sign-in redirect carried no authorization code.')
  return code
}

/** The minimum of `fetch` this module uses, so a test can supply one in ten lines. */
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

export interface ExchangeRequest {
  clientId: string
  tenant: string
  redirectUri: string
  code: string
  verifier: string
}

export async function exchangeCode(request: ExchangeRequest, fetcher: Fetcher): Promise<Tokens> {
  return post(request.tenant, fetcher, {
    client_id: request.clientId,
    grant_type: 'authorization_code',
    code: request.code,
    redirect_uri: request.redirectUri,
    code_verifier: request.verifier,
    scope: GRAPH_SCOPES.join(' ')
  })
}

export interface RefreshRequest {
  clientId: string
  tenant: string
  refreshToken: string
}

export async function refreshTokens(request: RefreshRequest, fetcher: Fetcher): Promise<Tokens> {
  return post(request.tenant, fetcher, {
    client_id: request.clientId,
    grant_type: 'refresh_token',
    refresh_token: request.refreshToken,
    scope: GRAPH_SCOPES.join(' ')
  })
}

async function post(tenant: string, fetcher: Fetcher, form: Record<string, string>): Promise<Tokens> {
  const response = await fetcher(tokenUrl(tenant), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  })
  const body = await response.text()
  const parsed = parseJson(body)

  if (!response.ok) throw new Error(describeFailure(parsed, response.status))

  const accessToken = stringField(parsed, 'access_token')
  const refreshToken = stringField(parsed, 'refresh_token')
  if (!accessToken) throw new Error('Microsoft returned no access token.')
  // Without one of these the next hour is the last hour, and the author would
  // be sent back to a browser mid-chapter with no explanation.
  if (!refreshToken) throw new Error('Microsoft returned no refresh token — was offline_access granted?')

  const seconds = numberField(parsed, 'expires_in') ?? 3600
  return { accessToken, refreshToken, expiresAt: Date.now() + seconds * 1000 }
}

/**
 * Turn a token endpoint failure into something worth reading.
 *
 * `error_description` carries the AADSTS code and a sentence naming the actual
 * problem — a client id that does not exist, a redirect URI the registration
 * does not list — which is exactly what an author setting this up needs.
 */
function describeFailure(body: unknown, status: number): string {
  const description = stringField(body, 'error_description')
  if (description) return description.split(/\r?\n/)[0]!.trim()
  const error = stringField(body, 'error')
  if (error) return error
  return `Microsoft rejected the sign-in (HTTP ${status}).`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function stringField(body: unknown, name: string): string | null {
  if (!body || typeof body !== 'object') return null
  const value = (body as Record<string, unknown>)[name]
  return typeof value === 'string' && value ? value : null
}

function numberField(body: unknown, name: string): number | null {
  if (!body || typeof body !== 'object') return null
  const value = (body as Record<string, unknown>)[name]
  return typeof value === 'number' ? value : null
}

/** True when a token is gone or close enough to gone to be worth replacing. */
export function isExpired(tokens: Pick<Tokens, 'expiresAt'>, now = Date.now()): boolean {
  return tokens.expiresAt - EXPIRY_MARGIN_MS <= now
}
