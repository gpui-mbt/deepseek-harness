import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it } from 'vite-plus/test'
import { authorizationUrl, exchangeAuthorizationCode, refreshGrant, revokeRefreshToken } from '../src/oauth.ts'
import type { OAuthCompletion } from '../src/oauth.ts'

const issuer = 'https://auth.openai.com'
const clientId = 'client-for-test'
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

interface IdentityOptions {
  readonly azp?: string
  readonly issuer?: string
  readonly audience?: string
  readonly subject?: string | null
  readonly expiresAt?: number
  readonly noExpiry?: boolean
  readonly badSignature?: boolean
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function signedIdentity(
  nonce: string | undefined,
  options: IdentityOptions = {},
): Promise<{ readonly token: string; readonly jwks: unknown }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const jwk = await exportJWK(publicKey)
  const signingKey = options.badSignature === true ? (await generateKeyPair('ES256')).privateKey : privateKey
  let builder = new SignJWT({
    ...(nonce === undefined ? {} : { nonce }),
    ...(options.azp === undefined ? {} : { azp: options.azp }),
    email: 'person@example.com',
    email_verified: true,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? clientId)
    .setIssuedAt()
  if (options.noExpiry !== true) builder = builder.setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1_000) + 300)
  if (options.subject !== null) builder = builder.setSubject(options.subject ?? 'verified-subject')
  const token = await builder.sign(signingKey)
  return {
    token,
    jwks: { keys: [{ ...jwk, kid: 'test-key', alg: 'ES256', use: 'sig' }] },
  }
}

async function exchange(
  nonce: string | undefined,
  scope = scopes,
  includeRefreshToken = true,
  identityOptions: IdentityOptions = {},
): Promise<OAuthCompletion> {
  const identity = await signedIdentity(nonce, identityOptions)
  const fetcher: typeof fetch = async input => {
    const url = input instanceof Request ? input.url : typeof input === 'string' ? input : input.href
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        revocation_endpoint: `${issuer}/api/accounts/oauth/revoke`,
      })
    }
    if (url === `${issuer}/api/accounts/oauth/token`) {
      return jsonResponse({
        access_token: 'access-token',
        id_token: identity.token,
        ...(includeRefreshToken ? { refresh_token: 'refresh-token' } : {}),
        token_type: 'Bearer',
        expires_in: 3600,
        scope,
      })
    }
    if (url === `${issuer}/.well-known/jwks.json`) return jsonResponse(identity.jwks)
    throw new Error(`unexpected OAuth URL: ${url}`)
  }
  return await exchangeAuthorizationCode({
    code: 'authorization-code',
    clientId,
    verifier: 'a'.repeat(43),
    redirectUri: 'http://127.0.0.1:43123/auth/callback',
    nonce: 'expected-nonce',
    requestTimeoutMs: 5_000,
    fetcher,
  })
}

describe('Sign in with ChatGPT identity verification', () => {
  it('accepts the signed ID token only when the verified nonce matches this sign-in', async () => {
    await expect(exchange('expected-nonce')).resolves.toMatchObject({ status: 'connected' })
    await expect(exchange('different-nonce')).rejects.toThrow(/another sign-in request/u)
    await expect(exchange(undefined)).rejects.toThrow(/another sign-in request/u)
  })

  it.each([
    { reason: 'issuer', options: { issuer: 'https://attacker.example' } },
    { reason: 'audience', options: { audience: 'another-client' } },
    { reason: 'expiry', options: { expiresAt: Math.floor(Date.now() / 1_000) - 1 } },
    { reason: 'subject', options: { subject: '' } },
    { reason: 'signature', options: { badSignature: true } },
  ])('rejects a signed ID token with invalid $reason claims', async ({ options }) => {
    await expect(exchange('expected-nonce', scopes, true, options)).rejects.toThrow()
  })

  it('retains only a verified registration when plan scopes or renewal are missing', async () => {
    const missingDirectPermission = scopes.replace(' chatgpt.tokens.use.direct', '')
    const limited = await exchange('expected-nonce', missingDirectPermission)
    expect(limited).toMatchObject({
      status: 'needs-sign-in',
      registration: { clientId, subject: 'verified-subject', email: 'person@example.com' },
      missingScopes: ['chatgpt.tokens.use.direct'],
    })
    expect(JSON.stringify(limited)).not.toContain('access-token')
    expect(JSON.stringify(limited)).not.toContain('refresh-token')

    const noRefresh = await exchange('expected-nonce', scopes, false)
    expect(noRefresh).toMatchObject({
      status: 'needs-sign-in',
      registration: { clientId, subject: 'verified-subject' },
      missingScopes: [],
    })
    expect(JSON.stringify(noRefresh)).not.toContain('access-token')
  })
})

describe('ChatGPT sign-in request construction', () => {
  it('hints the saved account only for a reauthorization', () => {
    const reauthorize = new URL(authorizationUrl({
      clientId,
      hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      redirectUri: 'http://127.0.0.1:1/auth/callback',
      state: 'state',
      nonce: 'nonce',
      codeChallenge: 'challenge',
      newRegistration: false,
      loginHint: 'person@example.com',
    }))
    expect(reauthorize.searchParams.get('login_hint')).toBe('person@example.com')
    expect(reauthorize.searchParams.get('agent_name_hint')).toBeNull()
    expect(reauthorize.searchParams.get('ext_agent_host_id')).toBe('urn:uuid:00000000-0000-4000-8000-000000000001')
    expect(reauthorize.searchParams.get('code_challenge_method')).toBe('S256')

    const register = new URL(authorizationUrl({
      clientId,
      hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      redirectUri: 'http://127.0.0.1:1/auth/callback',
      state: 'state',
      nonce: 'nonce',
      codeChallenge: 'challenge',
      newRegistration: true,
      loginHint: 'ignored@example.com',
    }))
    expect(register.searchParams.get('agent_name_hint')).toBe('DeepSeek Harness')
    expect(register.searchParams.get('login_hint')).toBeNull()
  })
})

describe('ChatGPT sign-in failure reporting', () => {
  async function fetcherWith(
    identity: { readonly token: string; readonly jwks: unknown },
    tokenResponse: Record<string, unknown> | Response,
    metadata: Record<string, unknown> | Response = {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      revocation_endpoint: `${issuer}/api/accounts/oauth/revoke`,
    },
  ): Promise<typeof fetch> {
    return async input => {
      const url = input instanceof Request ? input.url : typeof input === 'string' ? input : input.href
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return metadata instanceof Response ? metadata : jsonResponse(metadata)
      }
      if (url === `${issuer}/api/accounts/oauth/token`) {
        return tokenResponse instanceof Response ? tokenResponse : jsonResponse(tokenResponse)
      }
      if (url === `${issuer}/.well-known/jwks.json`) return jsonResponse(identity.jwks)
      throw new Error(`unexpected OAuth URL: ${url}`)
    }
  }

  const completionInput = {
    code: 'authorization-code',
    clientId,
    verifier: 'a'.repeat(43),
    redirectUri: 'http://127.0.0.1:43123/auth/callback',
    nonce: 'expected-nonce',
    requestTimeoutMs: 5_000,
  }

  it('reports a refused token exchange with the provider code', async () => {
    const identity = await signedIdentity('expected-nonce')
    const fetcher = await fetcherWith(identity, new Response(JSON.stringify({ error: 'access_denied' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    }))
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher })).rejects.toMatchObject({
      message: 'ChatGPT token exchange failed',
      code: 'access_denied',
      status: 400,
    })
  })

  it('accepts a token response that omits the granted scope list', async () => {
    const identity = await signedIdentity('expected-nonce')
    const fetcher = await fetcherWith(identity, {
      access_token: 'access', id_token: identity.token, refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3_600,
    })
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher })).resolves.toMatchObject({
      status: 'needs-sign-in',
      missingScopes: scopes.split(' '),
    })
  })

  it('rejects a token response without an access token', async () => {
    const identity = await signedIdentity('expected-nonce')
    const fetcher = await fetcherWith(identity, { access_token: '', token_type: 'Bearer', expires_in: 3_600 })
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher }))
      .rejects.toThrow('ChatGPT response omitted access_token.')
  })

  it('rejects a token response without a signed identity token', async () => {
    const identity = await signedIdentity('expected-nonce')
    const fetcher = await fetcherWith(identity, {
      access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3_600, scope: scopes,
    })
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher }))
      .rejects.toThrow('ChatGPT did not return a signed identity token.')
  })

  it('rejects a token response with an invalid token type, lifetime, or scope list', async () => {
    const identity = await signedIdentity('expected-nonce')
    const base = {
      access_token: 'access', id_token: identity.token, refresh_token: 'refresh', token_type: 'MAC', expires_in: 3_600, scope: scopes,
    }
    const wrongType = await fetcherWith(identity, base)
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher: wrongType }))
      .rejects.toThrow('ChatGPT returned an unsupported token type.')
    const wrongLifetime = await fetcherWith(identity, { ...base, token_type: 'Bearer', expires_in: 0 })
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher: wrongLifetime }))
      .rejects.toThrow('ChatGPT returned an invalid token lifetime.')
    const wrongScope = await fetcherWith(identity, { ...base, token_type: 'Bearer', scope: ['openid'] })
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher: wrongScope }))
      .rejects.toThrow('ChatGPT returned invalid token scopes.')
  })

  it('rejects an unreadable or non-object token response', async () => {
    const identity = await signedIdentity('expected-nonce')
    const unreadable = await fetcherWith(identity, new Response('not json', { status: 200 }))
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher: unreadable }))
      .rejects.toThrow('ChatGPT returned an unreadable response.')
    const arrayBody = await fetcherWith(identity, jsonResponse([]))
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher: arrayBody }))
      .rejects.toThrow('ChatGPT returned an invalid response.')
  })

  it('rejects an identity token for another client, an expired token, or a mismatched saved account', async () => {
    const otherClient = await signedIdentity('expected-nonce', { azp: 'another-client' })
    const wrongAuthorizedParty = await fetcherWith(otherClient, {
      access_token: 'access', id_token: otherClient.token, refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3_600, scope: scopes,
    })
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher: wrongAuthorizedParty }))
      .rejects.toThrow('ChatGPT returned an identity token for another client.')

    const expired = await signedIdentity('expected-nonce', { noExpiry: true })
    const expiredFetch = await fetcherWith(expired, {
      access_token: 'access', id_token: expired.token, refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3_600, scope: scopes,
    })
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher: expiredFetch }))
      .rejects.toThrow('ChatGPT returned an expired or non-expiring identity token.')

    const identity = await signedIdentity('expected-nonce')
    const mismatched = await fetcherWith(identity, {
      access_token: 'access', id_token: identity.token, refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3_600, scope: scopes,
    })
    await expect(exchangeAuthorizationCode({
      ...completionInput,
      fetcher: mismatched,
      expectedIdentity: { clientId, subject: 'another-subject' },
    })).rejects.toThrow('The selected ChatGPT account or workspace did not match this registration.')
  })

  it('rejects untrusted or unavailable sign-in metadata', async () => {
    const identity = await signedIdentity('expected-nonce')
    const tokenBody = {
      access_token: 'access', id_token: identity.token, refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3_600, scope: scopes,
    }
    const unavailable = await fetcherWith(identity, tokenBody, new Response(JSON.stringify({}), {
      status: 503, headers: { 'content-type': 'application/json' },
    }))
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher: unavailable }))
      .rejects.toThrow('ChatGPT sign-in metadata could not be loaded')
    const wrongIssuer = await fetcherWith(identity, tokenBody, {
      issuer: 'https://evil.example', jwks_uri: `${issuer}/.well-known/jwks.json`, revocation_endpoint: `${issuer}/revoke`,
    })
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher: wrongIssuer }))
      .rejects.toThrow('ChatGPT sign-in metadata returned an unexpected issuer.')
    const untrusted = await fetcherWith(identity, tokenBody, {
      issuer, jwks_uri: 'http://127.0.0.1/jwks.json', revocation_endpoint: `${issuer}/revoke`,
    })
    await expect(exchangeAuthorizationCode({ ...completionInput, fetcher: untrusted }))
      .rejects.toThrow('ChatGPT sign-in metadata returned an untrusted endpoint.')
  })
})

describe('ChatGPT grant refresh and revocation', () => {
  const grantedScopes = scopes.split(' ')
  const previous = {
    clientId,
    subject: 'verified-subject',
    email: 'old@example.com',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    idToken: 'old-id-token',
    expiresAt: 0,
    scopes: grantedScopes,
  }

  it('reports a refused refresh with the provider code', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    })
    await expect(refreshGrant({ previous, requestTimeoutMs: 5_000, fetcher })).rejects.toMatchObject({
      message: 'ChatGPT token refresh failed',
      code: 'invalid_grant',
      status: 400,
    })
  })

  it('rejects a refreshed identity that no longer matches the saved account', async () => {
    const identity = await signedIdentity(undefined, { subject: 'another-subject' })
    const fetcher: typeof fetch = async input => {
      const url = input instanceof Request ? input.url : typeof input === 'string' ? input : input.href
      if (url === `${issuer}/api/accounts/oauth/token`) {
        return jsonResponse({
          access_token: 'new-access', refresh_token: 'new-refresh', id_token: identity.token,
          token_type: 'Bearer', expires_in: 3_600, scope: scopes,
        })
      }
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return jsonResponse({
          issuer, jwks_uri: `${issuer}/.well-known/jwks.json`, revocation_endpoint: `${issuer}/revoke`,
        })
      }
      if (url === `${issuer}/.well-known/jwks.json`) return jsonResponse(identity.jwks)
      throw new Error(`unexpected OAuth URL: ${url}`)
    }
    await expect(refreshGrant({ previous, requestTimeoutMs: 5_000, fetcher }))
      .rejects.toThrow('The refreshed ChatGPT identity did not match the saved account.')
  })

  it('accepts a refresh whose verified identity and email still match', async () => {
    const identity = await signedIdentity(undefined, { subject: 'verified-subject' })
    const refreshFetch = async (): Promise<Response> => jsonResponse({
      access_token: 'new-access', refresh_token: 'new-refresh', id_token: identity.token,
      token_type: 'Bearer', expires_in: 3_600, scope: scopes,
    })
    const fetcher: typeof fetch = async input => {
      const url = input instanceof Request ? input.url : typeof input === 'string' ? input : input.href
      if (url === `${issuer}/api/accounts/oauth/token`) return await refreshFetch()
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return jsonResponse({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json`, revocation_endpoint: `${issuer}/revoke` })
      }
      if (url === `${issuer}/.well-known/jwks.json`) return jsonResponse(identity.jwks)
      throw new Error(`unexpected OAuth URL: ${url}`)
    }
    const refreshed = await refreshGrant({ previous, requestTimeoutMs: 5_000, fetcher })
    expect(refreshed).toMatchObject({ accessToken: 'new-access', email: 'person@example.com', subject: 'verified-subject' })
  })

  it('keeps the saved identity and scopes when a refresh omits them', async () => {
    const fetcher: typeof fetch = async () => jsonResponse({
      access_token: 'new-access', token_type: 'Bearer', expires_in: 3_600,
    })
    const refreshed = await refreshGrant({ previous, requestTimeoutMs: 5_000, fetcher })
    expect(refreshed).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'old-refresh',
      idToken: 'old-id-token',
      email: 'old@example.com',
      scopes: grantedScopes,
    })
  })

  it('rejects a refresh that drops a required plan scope', async () => {
    const fetcher: typeof fetch = async () => jsonResponse({
      access_token: 'new-access', token_type: 'Bearer', expires_in: 3_600, scope: 'openid profile',
    })
    await expect(refreshGrant({ previous, requestTimeoutMs: 5_000, fetcher }))
      .rejects.toThrow('ChatGPT plan use was not authorized for this sign-in.')
  })

  it('retries one unavailable revocation response before reporting it unconfirmed', async () => {
    let calls = 0
    const fetcher: typeof fetch = async input => {
      const url = input instanceof Request ? input.url : typeof input === 'string' ? input : input.href
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return jsonResponse({ issuer, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` })
      }
      if (url === `${issuer}/revoke`) {
        calls++
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    }
    await expect(revokeRefreshToken({ clientId, refreshToken: 'token', requestTimeoutMs: 5_000, fetcher }))
      .resolves.toBe(false)
    expect(calls).toBe(2)
  })

  it('retries a transport failure once before reporting revocation unconfirmed', async () => {
    let calls = 0
    const fetcher: typeof fetch = async input => {
      const url = input instanceof Request ? input.url : typeof input === 'string' ? input : input.href
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return jsonResponse({ issuer, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` })
      }
      if (url === `${issuer}/revoke`) {
        calls++
        if (calls === 1) throw new Error('connection reset')
        return new Response(null, { status: 200 })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    }
    await expect(revokeRefreshToken({ clientId, refreshToken: 'token', requestTimeoutMs: 5_000, fetcher }))
      .resolves.toBe(true)
    expect(calls).toBe(2)
  })

  it('reports whether revocation was confirmed and treats unavailable endpoints as unconfirmed', async () => {
    const configured = (revokeStatus: () => Response | Promise<Response>): typeof fetch => async input => {
      const url = input instanceof Request ? input.url : typeof input === 'string' ? input : input.href
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return jsonResponse({ issuer, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` })
      }
      if (url === `${issuer}/revoke`) return await revokeStatus()
      throw new Error(`unexpected OAuth URL: ${url}`)
    }
    await expect(revokeRefreshToken({
      clientId, refreshToken: 'token', requestTimeoutMs: 5_000, fetcher: configured(() => new Response(null, { status: 200 })),
    })).resolves.toBe(true)
    await expect(revokeRefreshToken({
      clientId, refreshToken: 'token', requestTimeoutMs: 5_000, fetcher: configured(() => new Response(null, { status: 400 })),
    })).resolves.toBe(false)
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
    await expect(revokeRefreshToken({
      clientId, refreshToken: 'token', requestTimeoutMs: 5_000, fetcher: configured(() => { throw aborted }),
    })).resolves.toBe(false)
    await expect(revokeRefreshToken({
      clientId, refreshToken: 'token', requestTimeoutMs: 5_000, fetcher: async () => { throw new Error('offline') },
    })).resolves.toBe(false)
  })
})
