import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  createPkcePair,
  createState,
  authorizeUrl,
  tokenUrl,
  parseCallback,
  loopbackRedirectUri,
  exchangeCode,
  refreshTokens,
  isExpired,
  GRAPH_SCOPES,
  EXPIRY_MARGIN_MS,
  type Fetcher
} from './oauth.js'

/** A token endpoint that answers with whatever the test hands it. */
function endpoint(status: number, body: unknown): { fetcher: Fetcher; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, body: init.body ?? '' })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    }
  }
  return { fetcher, calls }
}

describe('PKCE', () => {
  it('challenges with the SHA-256 of the verifier', () => {
    const { verifier, challenge } = createPkcePair()
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('is url-safe and unguessable', () => {
    const { verifier, challenge } = createPkcePair()
    // Anything needing escaping in a query string would corrupt the request.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createPkcePair().verifier).not.toBe(verifier)
    expect(createState()).not.toBe(createState())
  })
})

describe('authorizeUrl', () => {
  const request = {
    clientId: 'app-1',
    tenant: 'common',
    redirectUri: 'http://localhost:52111',
    challenge: 'chal',
    state: 'st'
  }

  it('asks for a code bound to the challenge', () => {
    const url = new URL(authorizeUrl(request))
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(request.redirectUri)
    expect(url.searchParams.get('state')).toBe('st')
  })

  it('asks for offline access, or there is no staying signed in', () => {
    const scope = new URL(authorizeUrl(request)).searchParams.get('scope')!.split(' ')
    expect(scope).toContain('offline_access')
    expect(scope).toContain('Files.ReadWrite')
    expect(scope).toEqual([...GRAPH_SCOPES])
  })

  it('carries no client secret, because a desktop app cannot keep one', () => {
    expect(authorizeUrl(request)).not.toContain('client_secret')
  })

  it('honours a single-tenant registration', () => {
    const url = authorizeUrl({ ...request, tenant: 'contoso.onmicrosoft.com' })
    expect(url).toContain('/contoso.onmicrosoft.com/oauth2/')
  })

  it('falls back to the multi-tenant authority rather than building a broken URL', () => {
    expect(tokenUrl('')).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
  })
})

describe('loopbackRedirectUri', () => {
  it('carries no path, because only the port is ignored when matching', () => {
    /*
     * The bug this exists for: the documented registration is `http://localhost`,
     * and Microsoft ignores the port when matching a loopback redirect against
     * it — but nothing else. A request for `http://localhost:52111/callback` is
     * refused with AADSTS50011 on the authorize URL, so the browser never
     * redirects back and the app sees a sign-in that hangs and then times out.
     */
    const uri = loopbackRedirectUri(52111)
    expect(uri).toBe('http://localhost:52111')
    const parsed = new URL(uri)
    expect(parsed.pathname).toBe('/')
    expect(uri.replace(`:${parsed.port}`, '')).toBe('http://localhost')
  })
})

describe('parseCallback', () => {
  it('reads the code out of the redirect', () => {
    expect(parseCallback('http://localhost:1/callback?code=abc&state=st', 'st')).toBe('abc')
  })

  it('refuses a redirect from a different attempt', () => {
    // A code arriving with someone else's state is either stale or forged, and
    // spending it would be spending someone else's authorization.
    expect(() => parseCallback('http://localhost:1/?code=abc&state=other', 'st')).toThrow(
      /did not match/
    )
    expect(() => parseCallback('http://localhost:1/?code=abc', 'st')).toThrow(/did not match/)
  })

  it('surfaces what Microsoft said went wrong', () => {
    const url =
      'http://localhost:1/?error=access_denied&error_description=AADSTS65004%3A+The+user+declined&state=st'
    expect(() => parseCallback(url, 'st')).toThrow(/AADSTS65004/)
  })

  it('does not mistake an empty redirect for a success', () => {
    expect(() => parseCallback('http://localhost:1/?state=st', 'st')).toThrow(/no authorization code/)
  })
})

describe('exchangeCode', () => {
  const request = {
    clientId: 'app-1',
    tenant: 'common',
    redirectUri: 'http://localhost:52111',
    code: 'the-code',
    verifier: 'the-verifier'
  }

  it('proves the code with the verifier and stores what comes back', async () => {
    const { fetcher, calls } = endpoint(200, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600
    })
    const before = Date.now()
    const tokens = await exchangeCode(request, fetcher)

    const form = new URLSearchParams(calls[0]!.body)
    expect(calls[0]!.url).toBe(tokenUrl('common'))
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code_verifier')).toBe('the-verifier')
    expect(form.get('client_secret')).toBeNull()

    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
  })

  it('reports the AADSTS code rather than an HTTP status', async () => {
    // "400" tells an author nothing; "the application was not found in the
    // directory" tells them they pasted the wrong client id.
    const { fetcher } = endpoint(400, {
      error: 'unauthorized_client',
      error_description:
        'AADSTS700016: Application with identifier was not found in the directory.\r\nTrace ID: x'
    })
    await expect(exchangeCode(request, fetcher)).rejects.toThrow(/AADSTS700016/)
    await expect(exchangeCode(request, fetcher)).rejects.not.toThrow(/Trace ID/)
  })

  it('refuses a grant that would expire with no way back', async () => {
    // A tenant that withholds offline_access hands back an access token that
    // works for an hour and then sends the author to a browser mid-chapter.
    const { fetcher } = endpoint(200, { access_token: 'at', expires_in: 3600 })
    await expect(exchangeCode(request, fetcher)).rejects.toThrow(/offline_access/)
  })

  it('survives a gateway that answers with HTML', async () => {
    const { fetcher } = endpoint(502, '<html>Bad Gateway</html>')
    await expect(exchangeCode(request, fetcher)).rejects.toThrow(/HTTP 502/)
  })
})

describe('refreshTokens', () => {
  it('spends the stored token and expects a fresh one back', async () => {
    // Microsoft rotates the refresh token on every use, so a caller that keeps
    // the old one is signed out at the next refresh.
    const { fetcher, calls } = endpoint(200, {
      access_token: 'at2',
      refresh_token: 'rt2',
      expires_in: 60
    })
    const tokens = await refreshTokens({ clientId: 'app-1', tenant: 'common', refreshToken: 'rt1' }, fetcher)
    const form = new URLSearchParams(calls[0]!.body)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('rt1')
    expect(tokens.refreshToken).toBe('rt2')
  })
})

describe('isExpired', () => {
  it('replaces a token before it dies, not after', () => {
    const now = 1_000_000
    expect(isExpired({ expiresAt: now + EXPIRY_MARGIN_MS + 1000 }, now)).toBe(false)
    // A token with four minutes left would expire mid-upload.
    expect(isExpired({ expiresAt: now + EXPIRY_MARGIN_MS - 1000 }, now)).toBe(true)
    expect(isExpired({ expiresAt: now - 1 }, now)).toBe(true)
  })
})
