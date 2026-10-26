/** Sign in with ChatGPT OAuth and OpenID Connect protocol operations. */
import { createHash, randomBytes } from 'node:crypto'
import { customFetch, createRemoteJWKSet, jwtVerify } from 'jose'

const AUTH_ORIGIN = 'https://auth.openai.com'
const AUTHORIZE_URL = `${AUTH_ORIGIN}/api/accounts/authorize`
const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`
const DISCOVERY_URL = `${AUTH_ORIGIN}/.well-known/openid-configuration`
const API_RESOURCE = 'https://api.openai.com/v1'
const REQUIRED_SCOPES = [
  'openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct',
] as const

/** Fetch function passed by Host code and replaced by deterministic tests. */
export type OAuthFetch = typeof fetch

/** One validated ChatGPT account and its current OAuth grant. */
export interface OAuthGrant {
  readonly clientId: string
  readonly subject: string
  readonly email?: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly idToken: string
  readonly expiresAt: number
  readonly scopes: readonly string[]
}

/** Stable account identity expected during reauthorization, if one was selected. */
export interface OAuthIdentityExpectation {
  readonly clientId: string
  readonly subject: string
}

/** Verified registration identity retained when a callback grants no usable token. */
export interface OAuthRegistration {
  readonly clientId: string
  readonly subject: string
  readonly email?: string
}

/** Verified result of one callback exchange; incomplete grants never carry tokens. */
export type OAuthCompletion =
  | { readonly status: 'connected'; readonly grant: OAuthGrant }
  | { readonly status: 'needs-sign-in'; readonly registration: OAuthRegistration; readonly missingScopes: readonly string[] }

/** OAuth failure safe to classify without including credentials or response bodies. */
export class OAuthError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message)
    this.name = 'OAuthError'
  }
}

/** One fresh, independent OAuth anti-forgery value.
 * @returns a base64url value from 32 random bytes.
 */
export function randomOAuthValue(): string {
  return randomBytes(32).toString('base64url')
}

/** Create the verifier used by PKCE S256.
 * @returns a base64url verifier from 48 random bytes.
 */
export function randomPkceVerifier(): string {
  return randomBytes(48).toString('base64url')
}

/** Compute the base64url S256 challenge for one verifier.
 * @param verifier - PKCE verifier generated for the attempt.
 * @returns the base64url SHA-256 challenge.
 */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** Build the approved system-browser URL for a new registration or saved account.
 * @param input - client, host, redirect, anti-forgery values, and registration mode.
 * @returns the authorization URL to open in the system browser.
 */
export function authorizationUrl(input: {
  readonly clientId: string
  readonly hostId: string
  readonly redirectUri: string
  readonly state: string
  readonly nonce: string
  readonly codeChallenge: string
  readonly newRegistration: boolean
  readonly loginHint?: string
}): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('ext_agent_host_id', input.hostId)
  if (input.newRegistration) url.searchParams.set('agent_name_hint', 'DeepSeek Harness')
  if (!input.newRegistration && input.loginHint !== undefined) url.searchParams.set('login_hint', input.loginHint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', REQUIRED_SCOPES.join(' '))
  url.searchParams.set('resource', API_RESOURCE)
  url.searchParams.set('state', input.state)
  url.searchParams.set('nonce', input.nonce)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('code_challenge', input.codeChallenge)
  return url.toString()
}

/** Exchange one callback code and validate its ID token and plan permission.
 * @param input - code, client, verifier, redirect, nonce, and optional saved identity.
 * @returns the verified completion, which carries tokens only when every scope was granted.
 */
export async function exchangeAuthorizationCode(input: {
  readonly code: string
  readonly clientId: string
  readonly verifier: string
  readonly redirectUri: string
  readonly nonce: string
  readonly expectedIdentity?: OAuthIdentityExpectation
  readonly requestTimeoutMs: number
  readonly signal?: AbortSignal
  readonly fetcher?: OAuthFetch
}): Promise<OAuthCompletion> {
  const fetcher = input.fetcher ?? fetch
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    resource: API_RESOURCE,
  })
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: requestSignal(input.requestTimeoutMs, input.signal),
  })
  const body = await responseObject(response)
  if (!response.ok) throw oauthResponseError(response.status, body, 'ChatGPT token exchange failed')
  const tokens = tokenResponse(body)
  const scopes = tokens.scope === undefined ? [] : splitScopes(tokens.scope)
  const idToken = tokens.id_token
  if (idToken === undefined) throw new OAuthError('ChatGPT did not return a signed identity token.')
  const identity = await verifyIdentity(idToken, input.clientId, input.nonce, input.requestTimeoutMs, fetcher, input.signal)
  if (input.expectedIdentity !== undefined) {
    if (identity.subject !== input.expectedIdentity.subject || input.clientId !== input.expectedIdentity.clientId) {
      throw new OAuthError('The selected ChatGPT account or workspace did not match this registration.')
    }
  }
  const registration: OAuthRegistration = {
    clientId: input.clientId,
    subject: identity.subject,
    ...(identity.email === undefined ? {} : { email: identity.email }),
  }
  const missingScopes = REQUIRED_SCOPES.filter(scope => !scopes.includes(scope))
  const refreshToken = tokens.refresh_token
  if (missingScopes.length > 0 || refreshToken === undefined) {
    return { status: 'needs-sign-in', registration, missingScopes }
  }
  return {
    status: 'connected',
    grant: {
      clientId: input.clientId,
      subject: identity.subject,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      accessToken: tokens.access_token,
      refreshToken,
      idToken,
      expiresAt: Date.now() + tokens.expires_in * 1_000,
      scopes,
    },
  }
}

/** Refresh one serialized account grant and validate any replacement identity.
 * @param input - previous grant, client id, and request deadline.
 * @returns the refreshed grant preserving the verified identity.
 */
export async function refreshGrant(input: {
  readonly previous: OAuthGrant
  readonly requestTimeoutMs: number
  readonly signal?: AbortSignal
  readonly fetcher?: OAuthFetch
}): Promise<OAuthGrant> {
  const fetcher = input.fetcher ?? fetch
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: input.previous.clientId,
    refresh_token: input.previous.refreshToken,
    resource: API_RESOURCE,
  })
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: requestSignal(input.requestTimeoutMs, input.signal),
  })
  const body = await responseObject(response)
  if (!response.ok) throw oauthResponseError(response.status, body, 'ChatGPT token refresh failed')
  const tokens = tokenResponse(body)
  const scopes = tokens.scope === undefined ? input.previous.scopes : splitScopes(tokens.scope)
  assertRequiredScopes(scopes)
  const identity = tokens.id_token === undefined
    ? undefined
    : await verifyIdentity(tokens.id_token, input.previous.clientId, undefined, input.requestTimeoutMs, fetcher, input.signal)
  if (identity !== undefined && identity.subject !== input.previous.subject) {
    throw new OAuthError('The refreshed ChatGPT identity did not match the saved account.')
  }
  return {
    clientId: input.previous.clientId,
    subject: input.previous.subject,
    ...(identity?.email === undefined ? input.previous.email === undefined ? {} : { email: input.previous.email } : { email: identity.email }),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? input.previous.refreshToken,
    idToken: tokens.id_token ?? input.previous.idToken,
    expiresAt: Date.now() + tokens.expires_in * 1_000,
    scopes,
  }
}

/** Revoke a saved refresh token, with one bounded retry after an unavailable response.
 * @param input - token, client id, and request deadline.
 * @returns whether the provider confirmed revocation.
 */
export async function revokeRefreshToken(input: {
  readonly clientId: string
  readonly refreshToken: string
  readonly requestTimeoutMs: number
  readonly fetcher?: OAuthFetch
}): Promise<boolean> {
  const fetcher = input.fetcher ?? fetch
  try {
    const discovery = await openIdConfiguration(fetcher, input.requestTimeoutMs)
    const body = new URLSearchParams({
      token: input.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: input.clientId,
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetcher(discovery.revocation_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(input.requestTimeoutMs),
        })
        if (response.ok) return true
        if (response.status < 500 || attempt === 1) return false
      } catch (error) {
        if (attempt === 1 || isAbortError(error)) return false
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } catch {
    return false
  }
  /* v8 ignore next -- the second attempt always returns inside the loop. */
  return false
}

interface IdentityClaims {
  readonly subject: string
  readonly email?: string
}

interface TokenResponse {
  readonly access_token: string
  readonly refresh_token?: string
  readonly id_token?: string
  readonly token_type: string
  readonly expires_in: number
  readonly scope?: string
}

interface OpenIdConfiguration {
  readonly issuer: string
  readonly jwks_uri: string
  readonly revocation_endpoint: string
}

async function verifyIdentity(
  idToken: string,
  clientId: string,
  nonce: string | undefined,
  requestTimeoutMs: number,
  fetcher: OAuthFetch,
  signal?: AbortSignal,
): Promise<IdentityClaims> {
  const config = await openIdConfiguration(fetcher, requestTimeoutMs, signal)
  const jwks = createRemoteJWKSet(new URL(config.jwks_uri), {
    timeoutDuration: requestTimeoutMs,
    [customFetch]: async (url, options) => {
      const candidates: readonly (AbortSignal | undefined)[] = [signal, options.signal]
      const signals = candidates.filter((candidate): candidate is AbortSignal => candidate !== undefined)
      const init: RequestInit = { method: 'GET', headers: options.headers, redirect: 'manual' }
      /* v8 ignore next -- jose always supplies its own request signal. */
      if (signals.length > 0) init.signal = AbortSignal.any(signals)
      return await fetcher(url, init)
    },
  })
  const verified = await jwtVerify(idToken, jwks, {
    issuer: config.issuer,
    audience: clientId,
    ...(nonce === undefined ? {} : { nonce }),
  })
  const { payload } = verified
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1_000)) {
    throw new OAuthError('ChatGPT returned an expired or non-expiring identity token.')
  }
  if (nonce !== undefined && payload.nonce !== nonce) {
    throw new OAuthError('ChatGPT returned an identity token for another sign-in request.')
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new OAuthError('ChatGPT returned an identity token without a subject.')
  }
  if (payload.azp !== undefined && payload.azp !== clientId) {
    throw new OAuthError('ChatGPT returned an identity token for another client.')
  }
  return {
    subject: payload.sub,
    ...(payload.email_verified === true && typeof payload.email === 'string' && payload.email.length > 0
      ? { email: payload.email }
      : {}),
  }
}

async function openIdConfiguration(fetcher: OAuthFetch, requestTimeoutMs: number, signal?: AbortSignal): Promise<OpenIdConfiguration> {
  const response = await fetcher(DISCOVERY_URL, { signal: requestSignal(requestTimeoutMs, signal) })
  const body = await responseObject(response)
  if (!response.ok) throw oauthResponseError(response.status, body, 'ChatGPT sign-in metadata could not be loaded')
  const issuer = stringField(body, 'issuer')
  const jwksUri = trustedAuthUrl(stringField(body, 'jwks_uri'))
  const revocationEndpoint = trustedAuthUrl(stringField(body, 'revocation_endpoint'))
  if (issuer !== AUTH_ORIGIN) throw new OAuthError('ChatGPT sign-in metadata returned an unexpected issuer.')
  return { issuer, jwks_uri: jwksUri, revocation_endpoint: revocationEndpoint }
}

function trustedAuthUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== AUTH_ORIGIN) {
    throw new OAuthError('ChatGPT sign-in metadata returned an untrusted endpoint.')
  }
  return url.toString()
}

function tokenResponse(body: Record<string, unknown>): TokenResponse {
  const accessToken = stringField(body, 'access_token')
  const idToken = body.id_token
  const tokenType = stringField(body, 'token_type')
  const expiresIn = body.expires_in
  const refreshToken = body.refresh_token
  const scope = body.scope
  if (tokenType.toLowerCase() !== 'bearer') throw new OAuthError('ChatGPT returned an unsupported token type.')
  if (typeof expiresIn !== 'number' || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
    throw new OAuthError('ChatGPT returned an invalid token lifetime.')
  }
  if (scope !== undefined && typeof scope !== 'string') throw new OAuthError('ChatGPT returned invalid token scopes.')
  return {
    access_token: accessToken,
    ...(typeof refreshToken === 'string' && refreshToken.length > 0 ? { refresh_token: refreshToken } : {}),
    ...(typeof idToken === 'string' && idToken.length > 0 ? { id_token: idToken } : {}),
    token_type: tokenType,
    expires_in: expiresIn,
    ...(typeof scope === 'string' ? { scope } : {}),
  }
}

function splitScopes(scope: string): string[] {
  return [...new Set(scope.split(/\s+/u).filter(Boolean))]
}

function assertRequiredScopes(scopes: readonly string[]): void {
  if (!REQUIRED_SCOPES.every(scope => scopes.includes(scope))) {
    throw new OAuthError('ChatGPT plan use was not authorized for this sign-in.')
  }
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  let value: unknown
  try { value = await response.json() }
  catch { throw new OAuthError('ChatGPT returned an unreadable response.', undefined, response.status) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OAuthError('ChatGPT returned an invalid response.', undefined, response.status)
  }
  return value as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) throw new OAuthError(`ChatGPT response omitted ${key}.`)
  return value
}

function oauthResponseError(status: number, body: Record<string, unknown>, fallback: string): OAuthError {
  const error = typeof body.error === 'string' ? body.error : undefined
  return new OAuthError(fallback, error, status)
}

function requestSignal(requestTimeoutMs: number, signal?: AbortSignal): AbortSignal {
  const candidates: readonly (AbortSignal | undefined)[] = [signal, AbortSignal.timeout(requestTimeoutMs)]
  return AbortSignal.any(candidates.filter((candidate): candidate is AbortSignal => candidate !== undefined))
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
