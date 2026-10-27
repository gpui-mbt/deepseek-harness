import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey, credentialKeyId } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { ChatGptHost } from '../src/host.ts'
import type { Config } from '../src/config.ts'
import type { ChatGptAccountId, ChatGptModelOverride } from '../src/types.ts'

const scopes = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']
const homes: string[] = []
const contexts: Context[] = []

function mutable<T>(initial: T): { get(): T; set(value: T): void } {
  let value = initial
  return {
    get: () => value,
    set: next => {
      value = next
    },
  }
}

function config(activeAccountId: string | undefined): {
  readonly config: Config
  readonly active: ReturnType<typeof mutable<string | undefined>>
  readonly overrides: ReturnType<typeof mutable<ChatGptModelOverride[]>>
  readonly timeouts: ReturnType<typeof mutable<number>>
} {
  const active = mutable(activeAccountId)
  const overrides = mutable<ChatGptModelOverride[]>([])
  const timeouts = mutable(10_000)
  return {
    active,
    overrides,
    timeouts,
    config: {
      activeAccountId: active,
      welcomeAcknowledged: mutable(false),
      authorizeOnStart: mutable(false),
      modelOverrides: overrides,
      requestTimeoutMs: timeouts,
      loginPollIntervalMs: mutable(1_000),
      loginTimeoutMs: mutable(30_000),
      streamIdleTimeoutMs: mutable(120_000),
    },
  }
}

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-siwc-host-'))
  homes.push(path)
  return path
}

interface HostFixture {
  readonly ctx: Context
  readonly host: ChatGptHost
  readonly active: ReturnType<typeof mutable<string | undefined>>
  readonly overrides: ReturnType<typeof mutable<ChatGptModelOverride[]>>
  readonly timeouts: ReturnType<typeof mutable<number>>
}

async function openHost(path: string, selected: string | undefined): Promise<HostFixture> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path: join(path, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  const refs = config(selected)
  const host = new ChatGptHost(ctx, refs.config)
  return { ctx, host, active: refs.active, overrides: refs.overrides, timeouts: refs.timeouts }
}

async function boot(path: string, selected: string | undefined, savedHostId?: string): Promise<HostFixture> {
  const fixture = await openHost(path, selected)
  if (savedHostId !== undefined) {
    await fixture.ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', 'host'), async () => ({
      kind: 'grant',
      payload: { version: 1, hostId: savedHostId },
    }))
  }
  await fixture.host.initialize()
  return fixture
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url
  return typeof input === 'string' ? input : input.href
}

function newAccountId(): ChatGptAccountId {
  return `account-${randomUUID()}` as ChatGptAccountId
}

async function seedAccount(
  ctx: Context,
  accountId: ChatGptAccountId,
  options: { readonly token: string; readonly expiresAt?: number; readonly createdAt?: number; readonly email?: string },
): Promise<void> {
  await ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', accountId), async () => ({
    kind: 'grant',
    payload: {
      version: 1,
      accountId,
      clientId: `client-${accountId}`,
      subject: `subject-${accountId}`,
      ...(options.email === undefined ? {} : { email: options.email }),
      grantGeneration: 0,
      accessToken: options.token,
      refreshToken: `refresh-${options.token}`,
      idToken: `id-${options.token}`,
      expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
      scopes,
      createdAt: options.createdAt ?? Date.now(),
      status: 'connected',
    },
  }))
}

function catalogResponse(displayName: string): Response {
  return new Response(
    JSON.stringify({
      models: [{ slug: 'gpt-6-astra', display_name: displayName, visibility: 'list' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('ChatGPT Host account selection and request pinning', () => {
  it('runs and commits a new registration through the public Authorization flow', async () => {
    const path = await home()
    const { ctx, host } = await boot(path, undefined)
    const ticket = await host.beginLogin()
    const authorize = new URL(ticket.authorizationUrl)
    const hostRecord = await ctx.credentials.readRecord(credentialKey('dsh-chatgpt', 'host'))
    if (hostRecord?.kind !== 'grant') throw new Error('ChatGPT Host did not persist its host identity.')
    const hostPayload: unknown = hostRecord.payload
    if (typeof hostPayload !== 'object' || hostPayload === null || !('hostId' in hostPayload)) {
      throw new Error('ChatGPT Host did not persist its host identity.')
    }
    const hostId = hostPayload.hostId
    expect(hostId).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)
    expect(authorize.searchParams.get('ext_agent_host_id')).toBe(hostId)
    const redirectUri = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    const nonce = authorize.searchParams.get('nonce')
    if (redirectUri === null || state === null || nonce === null) {
      throw new Error('ChatGPT authorize request omitted a required callback value')
    }
    const entry = ctx.authorization.list()[0]
    if (entry === undefined) throw new Error('ChatGPT Host did not register its authorization flow.')
    const accountId = credentialKeyId(entry.key)
    expect(accountId).toMatch(/^account-/)
    await expect(ctx.credentials.readRecord(entry.key)).resolves.toBeUndefined()

    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(publicKey)
    const issuedClientId = 'issued-client-for-new-registration'
    const idToken = await new SignJWT({ nonce, email: 'hiro@example.test' })
      .setProtectedHeader({ alg: 'ES256', kid: 'new-account-key' })
      .setIssuer('https://auth.openai.com')
      .setAudience(issuedClientId)
      .setSubject('subject-new-registration')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
            revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        return new Response(
          JSON.stringify({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            id_token: idToken,
            token_type: 'Bearer',
            expires_in: 3_600,
            scope: scopes.join(' '),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'new-account-key', alg: 'ES256', use: 'sig' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    })

    const callback = new URL(redirectUri)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'new-registration-code')
    callback.searchParams.set('client_id', issuedClientId)
    const callbackResponse = await nativeFetch(callback)
    expect(callbackResponse.status).toBe(200)
    await host.waitForLogin(ticket.attemptId)

    const saved = await ctx.credentials.readRecord(entry.key)
    expect(saved).toMatchObject({
      payload: {
        accountId,
        clientId: issuedClientId,
        subject: 'subject-new-registration',
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        status: 'connected',
      },
    })
    expect(ctx.authorization.list()).toHaveLength(1)
    const safeState = await host.getState()
    expect(JSON.stringify(safeState)).not.toContain('new-access-token')
    expect(JSON.stringify(safeState)).not.toContain('new-refresh-token')
  })

  it('migrates an existing bare UUID host ID to the SIWC URN without changing its UUID', async () => {
    const path = await home()
    const legacyId = randomUUID()
    const { ctx, host } = await boot(path, undefined, legacyId)
    const record = await ctx.credentials.readRecord(credentialKey('dsh-chatgpt', 'host'))
    expect(record).toMatchObject({ payload: { version: 1, hostId: `urn:uuid:${legacyId}` } })

    const ticket = await host.beginLogin()
    expect(new URL(ticket.authorizationUrl).searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${legacyId}`)
    await host.cancelLogin(ticket.attemptId)
  })

  it('returns the new login attempt when separate attempts share a millisecond timestamp', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await seedAccount(ctx, accountId, { token: 'timestamp-token' })
    const frozen = vi.spyOn(Date, 'now').mockReturnValue(1234)
    try {
      const first = await host.beginLogin(accountId)
      await host.cancelLogin(first.attemptId)
      const second = await host.beginLogin(accountId)
      expect(second.attemptId).not.toBe(first.attemptId)
      await host.cancelLogin(second.attemptId)
    } finally {
      frozen.mockRestore()
      await host.dispose()
    }
  })

  it('rejects beginLogin when Host disposal cancels a flow before it creates an attempt', async () => {
    const path = await home()
    const { ctx, host } = await boot(path, undefined)
    const originalRead = ctx.credentials.readRecord.bind(ctx.credentials)
    let readStarted!: () => void
    const started = new Promise<void>(resolve => {
      readStarted = resolve
    })
    let releaseRead!: () => void
    const release = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    const spy = vi.spyOn(ctx.credentials, 'readRecord').mockImplementation(async key => {
      if (credentialKeyId(key).startsWith('account-')) {
        readStarted()
        await release
      }
      return await originalRead(key)
    })
    try {
      const pending = host.beginLogin()
      await started
      await host.dispose()
      releaseRead()
      await expect(pending).rejects.toThrow()
      expect(ctx.authorization.list()).toEqual([])
    } finally {
      releaseRead()
      spy.mockRestore()
    }
  })

  it('does not start a late reauthorization when sign-out races the account lookup', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await seedAccount(ctx, accountId, { token: 'signout-race-token' })
    const originalRead = ctx.credentials.readRecord.bind(ctx.credentials)
    let readStarted!: () => void
    const started = new Promise<void>(resolve => {
      readStarted = resolve
    })
    let releaseRead!: () => void
    const release = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    const spy = vi.spyOn(ctx.credentials, 'readRecord').mockImplementation(async key => {
      if (credentialKeyId(key) === String(accountId)) {
        readStarted()
        await release
      }
      return await originalRead(key)
    })
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
    try {
      const pending = host.beginLogin(accountId)
      const pendingRejection = expect(pending).rejects.toThrow(/cancelled/u)
      await started
      await host.signOut(accountId)
      releaseRead()
      await pendingRejection
      expect((await host.getState()).loginAttempts).toEqual([])
      const saved = await ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))
      expect(saved).toMatchObject({ payload: { status: 'needs-sign-in', grantGeneration: 1 } })
    } finally {
      releaseRead()
      spy.mockRestore()
      await host.dispose()
    }
  })

  it('disconnects a registration that is not connected without revoking it', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', accountId), async () => ({
      kind: 'grant',
      payload: {
        version: 1,
        accountId,
        clientId: `client-${accountId}`,
        subject: `subject-${accountId}`,
        grantGeneration: 2,
        email: 'person@example.test',
        createdAt: 1,
        status: 'needs-sign-in',
      },
    }))
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(host.signOut(accountId)).resolves.toEqual({ revocationConfirmed: false })

    expect(fetch).not.toHaveBeenCalled()
    await expect(ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))).resolves.toMatchObject({
      payload: {
        grantGeneration: 3,
        email: 'person@example.test',
        status: 'needs-sign-in',
      },
    })
  })

  it('leaves another account sign-in running when a different account is disconnected', async () => {
    const path = await home()
    const pendingId = newAccountId()
    const otherId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await seedAccount(ctx, pendingId, { token: 'pending-token' })
    await seedAccount(ctx, otherId, { token: 'other-token' })
    const originalRead = ctx.credentials.readRecord.bind(ctx.credentials)
    let readStarted!: () => void
    const started = new Promise<void>(resolve => {
      readStarted = resolve
    })
    let releaseRead!: () => void
    const release = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    const spy = vi.spyOn(ctx.credentials, 'readRecord').mockImplementation(async key => {
      if (credentialKeyId(key) === String(pendingId)) {
        readStarted()
        await release
      }
      return await originalRead(key)
    })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (requestUrl(input) === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
            revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(null, { status: 200 })
    })
    try {
      const pending = host.beginLogin(pendingId)
      await started
      await expect(host.signOut(otherId)).resolves.toEqual({ revocationConfirmed: true })
      releaseRead()
      const ticket = await pending
      expect(ticket.authorizationUrl).toContain('https://auth.openai.com/')
      await host.cancelLogin(ticket.attemptId)
    } finally {
      releaseRead()
      spy.mockRestore()
      await host.dispose()
    }
  })

  it.each([
    { label: 'a verified email', email: 'hiro@example.test' as string | undefined },
    { label: 'no email', email: undefined },
  ])('retains verified client registration with $label without persisting tokens when plan permission is missing', async ({ email }) => {
    const path = await home()
    const { ctx, host } = await boot(path, undefined)
    const ticket = await host.beginLogin()
    const authorize = new URL(ticket.authorizationUrl)
    const redirect = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    const nonce = authorize.searchParams.get('nonce')
    if (redirect === null || state === null || nonce === null) throw new Error('ChatGPT authorize request omitted a callback value')
    const entry = ctx.authorization.list()[0]
    if (entry === undefined) throw new Error('ChatGPT Host did not register its authorization flow.')
    const accountId = credentialKeyId(entry.key)
    const issuedClientId = 'issued-client-without-plan-scope'
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(publicKey)
    const idToken = await new SignJWT({
      nonce,
      ...(email === undefined ? {} : { email, email_verified: true }),
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'limited-account-key' })
      .setIssuer('https://auth.openai.com')
      .setAudience(issuedClientId)
      .setSubject('verified-limited-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
            revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        return new Response(
          JSON.stringify({
            access_token: 'limited-access-token',
            refresh_token: 'limited-refresh-token',
            id_token: idToken,
            token_type: 'Bearer',
            expires_in: 3_600,
            scope: 'openid profile email offline_access resource.invoke',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'limited-account-key', alg: 'ES256', use: 'sig' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    })

    const callback = new URL(redirect)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'limited-permission-code')
    callback.searchParams.set('client_id', issuedClientId)
    await expect(nativeFetch(callback)).resolves.toMatchObject({ status: 400 })
    await expect(host.waitForLogin(ticket.attemptId)).rejects.toThrow(/permissions needed/u)

    const saved = await ctx.credentials.readRecord(entry.key)
    expect(saved).toMatchObject({
      payload: {
        accountId,
        clientId: issuedClientId,
        subject: 'verified-limited-subject',
        status: 'needs-sign-in',
        ...(email === undefined ? {} : { email }),
      },
    })
    if (saved?.kind !== 'grant') throw new Error('The incomplete ChatGPT registration was not saved.')
    if (email === undefined) expect(saved.payload).not.toHaveProperty('email')
    expect(saved.payload).not.toHaveProperty('accessToken')
    expect(saved.payload).not.toHaveProperty('refreshToken')
    expect(saved.payload).not.toHaveProperty('idToken')
    await expect(host.listModels()).resolves.toEqual([])
  })

  it('preserves the previous connected grant when reauthorization omits plan permission', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await seedAccount(ctx, accountId, { token: 'original-access-token' })
    const ticket = await host.beginLogin(accountId)
    const authorize = new URL(ticket.authorizationUrl)
    const redirect = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    const nonce = authorize.searchParams.get('nonce')
    const clientId = authorize.searchParams.get('client_id')
    if (redirect === null || state === null || nonce === null || clientId === null) {
      throw new Error('ChatGPT reauthorization URL omitted a required callback value')
    }
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(publicKey)
    const idToken = await new SignJWT({ nonce, email: 'hiro@example.test', email_verified: true })
      .setProtectedHeader({ alg: 'ES256', kid: 'reauth-limited-key' })
      .setIssuer('https://auth.openai.com')
      .setAudience(clientId)
      .setSubject(`subject-${accountId}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
            revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        return new Response(
          JSON.stringify({
            access_token: 'limited-reauthorization-access-token',
            refresh_token: 'limited-reauthorization-refresh-token',
            id_token: idToken,
            token_type: 'Bearer',
            expires_in: 3_600,
            scope: 'openid profile email offline_access resource.invoke',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'reauth-limited-key', alg: 'ES256', use: 'sig' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    })

    const callback = new URL(redirect)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'limited-reauthorization-code')
    callback.searchParams.set('client_id', clientId)
    await expect(nativeFetch(callback)).resolves.toMatchObject({ status: 400 })
    await expect(host.waitForLogin(ticket.attemptId)).rejects.toThrow(/permissions needed/u)
    await expect(ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))).resolves.toMatchObject({
      payload: {
        status: 'connected',
        accessToken: 'original-access-token',
        refreshToken: 'refresh-original-access-token',
      },
    })
    const stateView = await host.getState()
    expect(JSON.stringify(stateView)).not.toContain('limited-reauthorization-access-token')
    expect(JSON.stringify(stateView)).not.toContain('limited-reauthorization-refresh-token')
  })

  it('rejects the dynamic-client placeholder instead of saving it as an issued registration', async () => {
    const path = await home()
    const { ctx, host } = await boot(path, undefined)
    const ticket = await host.beginLogin()
    const authorize = new URL(ticket.authorizationUrl)
    const redirect = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    if (redirect === null || state === null) throw new Error('ChatGPT authorize request omitted a callback value')
    const entry = ctx.authorization.list()[0]
    if (entry === undefined) throw new Error('ChatGPT Host did not register its authorization flow.')
    const callback = new URL(redirect)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'unissued-dynamic-client-code')
    callback.searchParams.set('client_id', 'dynamic_agent_client')
    const response = await globalThis.fetch(callback)
    expect(response.status).toBe(400)
    await expect(response.text()).resolves.toMatch(/did not issue a client registration/u)
    await expect(host.waitForLogin(ticket.attemptId)).rejects.toThrow(/did not issue/u)
    await expect(ctx.credentials.readRecord(entry.key)).resolves.toBeUndefined()
  })

  it('re-registers saved account authorization flows after restart and lets public callers cancel them', async () => {
    const path = await home()
    const accountId = newAccountId()
    const first = await boot(path, undefined)
    await seedAccount(first.ctx, accountId, { token: 'persisted-token' })
    await first.host.dispose()
    await first.ctx.fiber.dispose()

    const { ctx, host } = await boot(path, undefined)
    const key = credentialKey('dsh-chatgpt', accountId)
    expect(ctx.authorization.list()).toContainEqual(expect.objectContaining({ key, label: 'ChatGPT' }))
    let publish!: (url: string) => void
    const authorizeReady = new Promise<string>(resolve => {
      publish = resolve
    })
    const controller = new AbortController()
    const running = ctx.authorization.begin({
      key,
      signal: controller.signal,
      interaction: {
        notify: notice => {
          if (notice.url !== undefined) publish(notice.url)
        },
        prompt: async () => {
          throw new Error('ChatGPT does not request a prompt value')
        },
      },
    })
    const authorize = new URL(await authorizeReady)
    expect(authorize.searchParams.get('client_id')).toBe(`client-${accountId}`)
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/u)
    controller.abort()
    await expect(running).resolves.toEqual({ status: 'cancelled' })
    expect(ctx.authorization.list()).toContainEqual(expect.objectContaining({ key, label: 'ChatGPT' }))
    await expect(ctx.credentials.readRecord(key)).resolves.toMatchObject({
      payload: { status: 'connected', accessToken: 'persisted-token' },
    })
    await host.dispose()
  })

  it('uses the sole connected account but requires a choice among multiple accounts or a missing saved selection', async () => {
    const path = await home()
    const firstId = newAccountId()
    const secondId = newAccountId()
    const { ctx, host, active } = await boot(path, undefined)
    await seedAccount(ctx, firstId, { token: 'token-first', createdAt: 1 })
    await seedAccount(ctx, secondId, { token: 'token-second', createdAt: 2 })
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      return catalogResponse(authorization === 'Bearer token-first' ? 'First Astra' : 'Second Astra')
    })

    await expect(host.listModels()).resolves.toEqual([])

    active.set(String(firstId))
    await expect(host.listModels()).resolves.toMatchObject([{ id: 'gpt-6-astra', name: 'First Astra' }])

    active.set('account-missing')
    await expect(host.listModels()).resolves.toEqual([])
  })

  it('keeps the catalog model and token on the account captured before a profile switch', async () => {
    const path = await home()
    const firstId = newAccountId()
    const secondId = newAccountId()
    const { ctx, host, active, overrides, timeouts } = await boot(path, String(firstId))
    await seedAccount(ctx, firstId, { token: 'token-first', createdAt: 1 })
    await seedAccount(ctx, secondId, { token: 'token-second', createdAt: 2 })
    let started!: () => void
    const firstRequestStarted = new Promise<void>(resolve => {
      started = resolve
    })
    let release!: () => void
    const firstCatalogGate = new Promise<void>(resolve => {
      release = resolve
    })
    overrides.set([{ model: 'gpt-6-astra', contextWindow: 1111 }])
    timeouts.set(11_000)
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === 'Bearer token-first') {
        started()
        await firstCatalogGate
        return catalogResponse('First Astra')
      }
      return catalogResponse('Second Astra')
    })

    const preparedCall = host.prepareCall('gpt-6-astra')
    await firstRequestStarted
    active.set(String(secondId))
    overrides.set([{ model: 'gpt-6-astra', contextWindow: 2222 }])
    timeouts.set(22_000)
    release()
    const call = await preparedCall

    expect(call.accountId).toBe(firstId)
    expect(call.accessToken).toBe('token-first')
    expect(call.model.name).toBe('First Astra')
    expect(call.model.context?.contextWindow).toBe(1111)
    expect(call.requestTimeoutMs).toBe(11_000)

    const nextCall = await host.prepareCall('gpt-6-astra')
    expect(nextCall.accountId).toBe(secondId)
    expect(nextCall.accessToken).toBe('token-second')
    expect(nextCall.model.context?.contextWindow).toBe(2222)
    expect(nextCall.requestTimeoutMs).toBe(22_000)
  })

  it.each(['add', 'remove'] as const)('uses the captured model metadata when an override is %s during catalog lookup', async change => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host, overrides } = await boot(path, String(accountId))
    await seedAccount(ctx, accountId, { token: 'metadata-token' })
    const slug = change === 'add' ? 'gpt-6-astra' : 'unseeded-catalog-model'
    if (change === 'remove') overrides.set([{ model: slug, contextWindow: 1111 }])
    let requestStarted!: () => void
    const started = new Promise<void>(resolve => {
      requestStarted = resolve
    })
    let releaseCatalog!: () => void
    const release = new Promise<void>(resolve => {
      releaseCatalog = resolve
    })
    vi.stubGlobal('fetch', async () => {
      requestStarted()
      await release
      return new Response(
        JSON.stringify({
          models: [{ slug, display_name: 'Catalog Model', visibility: 'list' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const pending = host.prepareCall(slug)
    await started
    overrides.set(change === 'add' ? [{ model: slug, contextWindow: 2222, inputModalities: ['text'] }] : [])
    releaseCatalog()
    if (change === 'add') {
      await expect(pending).resolves.toMatchObject({
        model: { context: { contextWindow: 1_050_000 }, inputModalities: ['text', 'image'] },
      })
    } else {
      await expect(pending).resolves.toMatchObject({ model: { context: { contextWindow: 1111 } } })
    }
  })

  it('refreshes the server catalog and prevents an older pending lookup from replacing it', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await seedAccount(ctx, accountId, { token: 'token-one' })
    let firstStarted!: () => void
    const firstRequestStarted = new Promise<void>(resolve => {
      firstStarted = resolve
    })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let catalogRequests = 0
    vi.stubGlobal('fetch', async () => {
      catalogRequests++
      if (catalogRequests === 1) {
        firstStarted()
        await firstGate
        return catalogResponse('Old Astra')
      }
      return catalogResponse('Refreshed Astra')
    })

    const oldLookup = host.listModels()
    await firstRequestStarted
    await host.refreshModels(accountId)
    releaseFirst()
    await oldLookup

    await expect(host.listModels()).resolves.toMatchObject([{ id: 'gpt-6-astra', name: 'Refreshed Astra' }])
    expect(catalogRequests).toBe(2)
  })

  it('aborts catalog work on logout and never returns a prepared token afterward', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await seedAccount(ctx, accountId, { token: 'token-one' })
    let firstStarted!: () => void
    const firstRequestStarted = new Promise<void>(resolve => {
      firstStarted = resolve
    })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input) === 'https://api.openai.com/v1/models') {
        requestSignal = init?.signal as AbortSignal
        firstStarted()
        await firstGate
        return catalogResponse('Astra')
      }
      if (requestUrl(input) === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
            revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (requestUrl(input) === 'https://auth.openai.com/api/accounts/oauth/revoke') return new Response(null, { status: 200 })
      throw new Error(`unexpected URL: ${requestUrl(input)}`)
    })

    const pending = host.prepareCall('gpt-6-astra')
    await firstRequestStarted
    await host.signOut(accountId)
    expect(requestSignal?.aborted).toBe(true)
    releaseFirst()
    await expect(pending).rejects.toThrow('ChatGPT account signed out')
  })

  it.each(['before reconciliation', 'before commit'] as const)(
    'does not restore a saved grant when another Host logs out %s',
    async timing => {
      const path = await home()
      const accountId = newAccountId()
      const loginHost = await boot(path, undefined)
      await seedAccount(loginHost.ctx, accountId, { token: 'token-one' })
      const logoutHost = await boot(path, undefined)
      const ticket = await loginHost.host.beginLogin(accountId)
      const authorize = new URL(ticket.authorizationUrl)
      const redirect = authorize.searchParams.get('redirect_uri')
      const state = authorize.searchParams.get('state')
      const nonce = authorize.searchParams.get('nonce')
      const clientId = authorize.searchParams.get('client_id')
      if (redirect === null || state === null || nonce === null || clientId === null) {
        throw new Error('ChatGPT authorize request omitted a required callback value')
      }
      const { privateKey, publicKey } = await generateKeyPair('ES256')
      const publicJwk = await exportJWK(publicKey)
      const idToken = await new SignJWT({ nonce })
        .setProtectedHeader({ alg: 'ES256', kid: 'reauth-key' })
        .setIssuer('https://auth.openai.com')
        .setAudience(clientId)
        .setSubject(`subject-${accountId}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
      const nativeFetch = globalThis.fetch
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = requestUrl(input)
        if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
          return new Response(
            JSON.stringify({
              issuer: 'https://auth.openai.com',
              jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
              revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') return new Response(null, { status: 200 })
        if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
          return new Response(
            JSON.stringify({
              access_token: 'reauthorized-access-token',
              refresh_token: 'reauthorized-refresh-token',
              id_token: idToken,
              token_type: 'Bearer',
              expires_in: 3_600,
              scope: scopes.join(' '),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url === 'https://auth.openai.com/.well-known/jwks.json') {
          return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'reauth-key', alg: 'ES256', use: 'sig' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`unexpected OAuth URL: ${url}`)
      })

      if (timing === 'before reconciliation') await logoutHost.host.signOut(accountId)
      else {
        const modify = loginHost.ctx.credentials.modifyRecord.bind(loginHost.ctx.credentials)
        let writes = 0
        vi.spyOn(loginHost.ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
          if (key === credentialKey('dsh-chatgpt', accountId) && ++writes === 2) {
            await logoutHost.host.signOut(accountId)
          }
          return modify(key, mutate)
        })
      }
      const callback = new URL(redirect)
      callback.searchParams.set('state', state)
      callback.searchParams.set('code', 'authorization-code')
      callback.searchParams.set('client_id', clientId)
      const callbackResponse = await nativeFetch(callback)
      expect(callbackResponse.status).toBe(400)
      const reopened = await boot(path, accountId)
      const saved = await reopened.ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))
      expect(saved).toMatchObject({ payload: { status: 'needs-sign-in', grantGeneration: 1 } })
      if (saved?.kind !== 'grant') throw new Error('logged-out ChatGPT account record is missing')
      expect(saved.payload).not.toHaveProperty('refreshToken')
    },
  )

  it('keeps cancellation effective while a real Credentials file lock blocks the grant write', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, String(accountId))
    await seedAccount(ctx, accountId, { token: 'old-access-token' })
    const key = credentialKey('dsh-chatgpt', accountId)
    let releaseLock!: () => void
    let lockEntered!: () => void
    const lockReady = new Promise<void>(resolve => {
      lockEntered = resolve
    })
    const lockGate = new Promise<void>(resolve => {
      releaseLock = resolve
    })
    const heldWrite = ctx.credentials.modifyRecord(key, async current => {
      lockEntered()
      await lockGate
      return current
    })
    await lockReady

    let queuedWrite!: () => void
    const writeQueued = new Promise<void>(resolve => {
      queuedWrite = resolve
    })
    const originalModify = ctx.credentials.modifyRecord.bind(ctx.credentials)
    vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (recordKey, mutate) => {
      if (recordKey === key) queuedWrite()
      return await originalModify(recordKey, mutate)
    })

    const ticket = await host.beginLogin(accountId)
    const authorize = new URL(ticket.authorizationUrl)
    const redirect = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    const nonce = authorize.searchParams.get('nonce')
    const clientId = authorize.searchParams.get('client_id')
    if (redirect === null || state === null || nonce === null || clientId === null) {
      throw new Error('ChatGPT authorize request omitted a required callback value')
    }
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(publicKey)
    const idToken = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: 'ES256', kid: 'queued-write-key' })
      .setIssuer('https://auth.openai.com')
      .setAudience(clientId)
      .setSubject(`subject-${accountId}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
            revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        return new Response(
          JSON.stringify({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            id_token: idToken,
            token_type: 'Bearer',
            expires_in: 3_600,
            scope: scopes.join(' '),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'queued-write-key', alg: 'ES256', use: 'sig' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    })

    const callback = new URL(redirect)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'authorization-code-waiting-for-lock')
    callback.searchParams.set('client_id', clientId)
    const callbackResponse = nativeFetch(callback)
    await writeQueued

    let cancelSettled!: () => void
    const authorizationSettled = new Promise<void>(resolve => {
      cancelSettled = resolve
    })
    const unlisten = ctx.on('authorization/settled', (settledKey, status) => {
      if (settledKey === key && status === 'cancelled') cancelSettled()
    })
    const cancel = host.cancelLogin(ticket.attemptId)
    await authorizationSettled
    releaseLock()
    await heldWrite
    await cancel
    unlisten()
    expect((await callbackResponse).status).toBe(400)
    await expect(ctx.credentials.readRecord(key)).resolves.toMatchObject({
      payload: {
        status: 'connected',
        accessToken: 'old-access-token',
        refreshToken: 'refresh-old-access-token',
      },
    })
  })

  it('serializes concurrent refreshes through the published file-backed Credentials provider', async () => {
    const path = await home()
    const accountId = newAccountId()
    const first = await boot(path, String(accountId))
    await seedAccount(first.ctx, accountId, { token: 'expired-token', expiresAt: 0 })
    const second = await boot(path, String(accountId))
    let refreshCount = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (requestUrl(input) === 'https://auth.openai.com/api/accounts/oauth/token') {
        refreshCount++
        await new Promise(resolve => setTimeout(resolve, 40))
        return new Response(
          JSON.stringify({
            access_token: 'rotated-access-token',
            refresh_token: 'rotated-refresh-token',
            token_type: 'Bearer',
            expires_in: 3_600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return catalogResponse('Astra')
    })

    const calls = await Promise.all([first.host.prepareCall('gpt-6-astra'), second.host.prepareCall('gpt-6-astra')])

    expect(refreshCount).toBe(1)
    expect(calls.map(call => call.accessToken)).toEqual(['rotated-access-token', 'rotated-access-token'])
    await expect(first.ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))).resolves.toMatchObject({
      payload: { refreshToken: 'rotated-refresh-token' },
    })
  })
})

describe('ChatGPT Host durable-record validation', () => {
  async function seedHost(ctx: Context, payload: unknown): Promise<void> {
    await ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', 'host'), async () => ({
      kind: 'grant',
      payload,
    }))
  }
  async function seedAccountPayload(ctx: Context, accountId: ChatGptAccountId, payload: unknown): Promise<void> {
    await ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', accountId), async () => ({
      kind: 'grant',
      payload,
    }))
  }

  it('rejects a saved host identity that is not a v4 UUID', async () => {
    const path = await home()
    const { ctx, host } = await openHost(path, undefined)
    await seedHost(ctx, { version: 1, hostId: 'not-a-uuid' })
    await expect(host.initialize()).rejects.toThrow('The saved ChatGPT host identity is invalid.')
  })

  it('rejects a host record that is not a grant object', async () => {
    const path = await home()
    const { ctx, host } = await openHost(path, undefined)
    await seedHost(ctx, [])
    await expect(host.initialize()).rejects.toThrow('The saved ChatGPT host identity record is invalid.')
  })

  it('rejects an account payload without its matching identity', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await openHost(path, undefined)
    await seedAccountPayload(ctx, accountId, {
      version: 1,
      accountId: 'account-other',
      clientId: 'c',
      subject: 's',
      createdAt: 1,
      status: 'needs-sign-in',
    })
    await expect(host.initialize()).rejects.toThrow('The saved ChatGPT account record is invalid.')
  })

  it('rejects an invalid grant generation and an incomplete connected grant', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await openHost(path, undefined)
    const base = { version: 1, accountId, clientId: 'c', subject: 's', createdAt: 1, status: 'connected' }
    await seedAccountPayload(ctx, accountId, {
      ...base,
      grantGeneration: -1,
      accessToken: 'a',
      refreshToken: 'r',
      idToken: 'i',
      expiresAt: 1,
      scopes: [],
    })
    await expect(host.initialize()).rejects.toThrow('The saved ChatGPT account record has an invalid grant generation.')
  })

  it('rejects a connected grant that dropped its tokens', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await openHost(path, undefined)
    await seedAccountPayload(ctx, accountId, {
      version: 1,
      accountId,
      clientId: 'c',
      subject: 's',
      createdAt: 1,
      status: 'connected',
      grantGeneration: 0,
    })
    await expect(host.initialize()).rejects.toThrow('The saved ChatGPT grant is incomplete.')
  })
})

describe('ChatGPT Host catalog and model resolution', () => {
  async function withAccount(): Promise<HostFixture & { accountId: ChatGptAccountId }> {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, String(accountId))
    await seedAccount(fixture.ctx, accountId, { token: 'valid-token' })
    return { ...fixture, accountId }
  }

  it('reports whether a connected account exists', async () => {
    const path = await home()
    const fixture = await boot(path, undefined)
    await expect(fixture.host.hasConnectedAccount()).resolves.toBe(false)
    const accountId = newAccountId()
    await seedAccount(fixture.ctx, accountId, { token: 'valid-token' })
    await expect(fixture.host.hasConnectedAccount()).resolves.toBe(true)
  })

  it('rejects an unreadable model catalog and an HTTP failure', async () => {
    const fixture = await withAccount()
    vi.stubGlobal('fetch', async () => new Response('<html>nope</html>', { status: 200 }))
    await expect(fixture.host.refreshModels(fixture.accountId)).rejects.toThrow('ChatGPT returned an unreadable model catalog.')
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ models: [] }), { status: 502 }))
    await expect(fixture.host.refreshModels(fixture.accountId)).rejects.toThrow('ChatGPT model catalog request failed with HTTP 502.')
  })

  it('rejects a catalog body without a model list and ignores malformed rows', async () => {
    const fixture = await withAccount()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ models: 'nope' }), { status: 200 }))
    await expect(fixture.host.refreshModels(fixture.accountId)).rejects.toThrow('ChatGPT returned an invalid model catalog.')
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            models: [
              null,
              { slug: '', visibility: 'list' },
              { slug: 'hidden', visibility: 'hidden' },
              { slug: 'gpt-6-astra', visibility: 'list' },
            ],
          }),
          { status: 200 },
        ),
    )
    const state = await fixture.host.refreshModels(fixture.accountId)
    expect(state.accounts.find(account => account.id === fixture.accountId)?.models.map(model => model.slug)).toEqual(['gpt-6-astra'])
  })

  it('resolves a documented model and refuses an unknown or unbounded one', async () => {
    const fixture = await withAccount()
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            models: [
              { slug: 'gpt-6-astra', visibility: 'list' },
              { slug: 'gpt-unbounded', visibility: 'list' },
            ],
          }),
          { status: 200 },
        ),
    )

    const resolved = await fixture.host.resolveModel('gpt-6-astra')
    expect(resolved.id).toBe('gpt-6-astra')
    await expect(fixture.host.resolveModel('gpt-missing')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await expect(fixture.host.resolveModel('gpt-unbounded')).rejects.toMatchObject({ code: 'MODEL_CONTEXT_REQUIRED' })
  })

  it('applies a capability override to the resolved reasoning efforts', async () => {
    const fixture = await withAccount()
    fixture.overrides.set([{ model: 'gpt-6-astra', contextWindow: 123_456, reasoningEfforts: ['high'], defaultReasoningEffort: 'high' }])
    vi.stubGlobal('fetch', async () => catalogResponse('Astra'))
    const resolved = await fixture.host.resolveModel('gpt-6-astra')
    expect(resolved.context?.contextWindow).toBe(123_456)
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['high'])
  })

  it('resolves official facts and exact slugs when catalog rows omit display names', async () => {
    const fixture = await withAccount()
    fixture.overrides.set([{ model: 'gpt-6.1-sol' }, { model: 'gpt-unbounded', contextWindow: 64_000 }])
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            models: [
              { slug: 'gpt-6.1-sol', display_name: '', visibility: 'list' },
              { slug: 'gpt-unbounded', display_name: '', visibility: 'list' },
            ],
          }),
          { status: 200 },
        ),
    )

    const official = await fixture.host.resolveModel('gpt-6.1-sol')
    expect(official).toMatchObject({
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1 Sol',
      context: { contextWindow: 1_050_000 },
      reasoning: { defaultEffort: 'medium' },
    })
    expect(official.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])

    const custom = await fixture.host.resolveModel('gpt-unbounded')
    expect(custom).toMatchObject({
      id: 'gpt-unbounded',
      name: 'gpt-unbounded',
      context: { contextWindow: 64_000 },
    })

    const view = (await fixture.host.getState()).accounts.find(account => account.id === fixture.accountId)
    expect(view?.models.find(model => model.slug === 'gpt-6.1-sol')?.defaultReasoningEffort).toBe('medium')
  })

  it('requires a single saved account before a request when several are connected', async () => {
    const path = await home()
    const fixture = await boot(path, undefined)
    await seedAccount(fixture.ctx, newAccountId(), { token: 'first-token' })
    await seedAccount(fixture.ctx, newAccountId(), { token: 'second-token' })
    vi.stubGlobal('fetch', async () => catalogResponse('Astra'))
    await expect(fixture.host.prepareCall('gpt-6-astra')).rejects.toMatchObject({ code: 'CHATGPT_SIGN_IN_REQUIRED' })
    await expect(fixture.host.listModels()).resolves.toEqual([])
  })

  it('rejects beginLogin for a missing saved account and a duplicate attempt', async () => {
    const path = await home()
    const fixture = await boot(path, undefined)
    await expect(fixture.host.beginLogin(newAccountId())).rejects.toThrow('The ChatGPT account registration is unavailable.')
    const accountId = newAccountId()
    await seedAccount(fixture.ctx, accountId, { token: 'valid-token' })
    const first = await fixture.host.beginLogin(accountId)
    await expect(fixture.host.beginLogin(accountId)).rejects.toThrow('already running')
    await expect(fixture.host.cancelLogin('login-missing' as never)).resolves.toBeUndefined()
    await fixture.host.cancelLogin(first.attemptId)
  })

  it('normalizes a non-Error failure while reading a saved account', async () => {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, undefined)
    const spy = vi.spyOn(fixture.ctx.credentials, 'readRecord').mockImplementation(async key => {
      if (credentialKeyId(key) === String(accountId)) throw 'storage offline'
      return undefined
    })
    try {
      await expect(fixture.host.beginLogin(accountId)).rejects.toThrow('ChatGPT sign-in failed.')
    } finally {
      spy.mockRestore()
    }
  })

  it('cancels a pending sign-in when its account is disconnected', async () => {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, String(accountId))
    await seedAccount(fixture.ctx, accountId, { token: 'valid-token' })
    const ticket = await fixture.host.beginLogin(accountId)
    const settled = expect(fixture.host.waitForLogin(ticket.attemptId)).rejects.toThrow()
    await expect(fixture.host.signOut(accountId)).rejects.toThrow('configuration editing')
    await settled
  })

  it('stops a pending sign-in when the Host shuts down', async () => {
    const path = await home()
    const fixture = await boot(path, undefined)
    const ticket = await fixture.host.beginLogin()
    const settled = fixture.host.waitForLogin(ticket.attemptId)
    await fixture.host.dispose()
    await expect(settled).rejects.toThrow()
    await expect(fixture.host.beginLogin()).rejects.toThrow('stopping')
  })
})

describe('ChatGPT Host request preparation and failure recovery', () => {
  async function connected(): Promise<HostFixture & { accountId: ChatGptAccountId }> {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, String(accountId))
    await seedAccount(fixture.ctx, accountId, { token: 'valid-token' })
    return { ...fixture, accountId }
  }

  it('rejects a host identity record for another version', async () => {
    const path = await home()
    const { ctx, host } = await openHost(path, undefined)
    await ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', 'host'), async () => ({
      kind: 'grant',
      payload: { version: 2, hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' },
    }))
    await expect(host.initialize()).rejects.toThrow('The saved ChatGPT host identity is invalid.')
  })

  it('rejects a catalog body that is not an object and coalesces concurrent loads', async () => {
    const fixture = await connected()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([]), { status: 200 }))
    await expect(fixture.host.refreshModels(fixture.accountId)).rejects.toThrow('ChatGPT returned an invalid model catalog.')

    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 10))
      return catalogResponse('Astra')
    })
    const [first, second] = await Promise.all([fixture.host.listModels(), fixture.host.listModels()])
    expect(calls).toBe(1)
    expect(first.map(model => model.id)).toEqual(['gpt-6-astra'])
    expect(second).toEqual(first)
  })

  it('lists models with a capability override and reports a non-connected saved account', async () => {
    const fixture = await connected()
    fixture.overrides.set([{ model: 'gpt-6-astra', contextWindow: 200_000 }])
    vi.stubGlobal('fetch', async () => catalogResponse('Astra'))
    const models = await fixture.host.listModels()
    expect(models[0]).toMatchObject({ provider: 'chatgpt', id: 'gpt-6-astra', name: 'Astra' })
    const resolved = await fixture.host.resolveModel('gpt-6-astra')
    expect(resolved.context?.contextWindow).toBe(200_000)

    await fixture.host.signOut(fixture.accountId).catch(() => undefined)
    await expect(fixture.host.refreshModels(fixture.accountId)).rejects.toThrow('The ChatGPT account registration is unavailable.')
  })

  it('rejects sign-out for an account with no stored record', async () => {
    const path = await home()
    const fixture = await boot(path, undefined)
    await expect(fixture.host.signOut(newAccountId())).rejects.toThrow('The ChatGPT account registration is unavailable.')
  })

  it.each(['prepareCall', 'resolveModel', 'listModels'] as const)(
    'rejects %s when shutdown overtakes the initial account read',
    async operation => {
      const fixture = await connected()
      const original = fixture.ctx.credentials.readRecord.bind(fixture.ctx.credentials)
      let release: (() => void) | undefined
      let entered: (() => void) | undefined
      const blocked = new Promise<void>(resolve => {
        release = resolve
      })
      const started = new Promise<void>(resolve => {
        entered = resolve
      })
      vi.spyOn(fixture.ctx.credentials, 'readRecord').mockImplementation(async key => {
        entered?.()
        await blocked
        return original(key)
      })
      const fetch = vi.fn(async () => catalogResponse('Astra'))
      vi.stubGlobal('fetch', fetch)
      const pending = operation === 'listModels' ? fixture.host.listModels() : fixture.host[operation]('gpt-6-astra')
      const rejected = expect(pending).rejects.toThrow('stopping')
      await started
      await fixture.host.dispose()
      release?.()
      await rejected
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('reports recent login attempts and rejects an unknown wait target', async () => {
    const path = await home()
    const fixture = await boot(path, undefined)
    const ticket = await fixture.host.beginLogin()
    const state = await fixture.host.getState()
    expect(state.loginAttempts.map(attempt => attempt.id)).toContain(ticket.attemptId)
    await expect(fixture.host.waitForLogin('login-missing' as never)).rejects.toThrow('ChatGPT sign-in attempt is no longer available.')
    await fixture.host.cancelLogin(ticket.attemptId)
    await fixture.host.dispose()
    await expect(fixture.host.dispose()).resolves.toBeUndefined()
  })

  it('reads an image only through the attachment service', async () => {
    const path = await home()
    const fixture = await boot(path, undefined)
    const ref = { attachmentId: 'image-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
    await expect(fixture.host.readImage(ref as never)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    const readImage = vi.fn(async () => ({ ref, data: Uint8Array.from([1]) }))
    fixture.ctx.provide('attachments', { readImage } as never)
    await expect(fixture.host.readImage(ref as never)).resolves.toMatchObject({ data: Uint8Array.from([1]) })
    expect(readImage).toHaveBeenCalledOnce()
  })

  it('degrades a grant to needs-sign-in when refresh reports invalid_grant', async () => {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, String(accountId))
    await seedAccount(fixture.ctx, accountId, { token: 'expired-token', expiresAt: 0 })
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await expect(fixture.host.prepareCall('gpt-6-astra')).rejects.toMatchObject({ code: 'CHATGPT_SIGN_IN_REQUIRED' })
    const record = await fixture.ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))
    expect(record).toMatchObject({ payload: { status: 'needs-sign-in', grantGeneration: 0 } })
    if (record?.kind !== 'grant') throw new Error('expected a saved grant record')
    expect(record.payload).not.toHaveProperty('accessToken')
  })

  it('keeps the saved email when a refresh reports invalid_grant', async () => {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, String(accountId))
    await seedAccount(fixture.ctx, accountId, { token: 'expired-token', expiresAt: 0, email: 'person@example.test' })
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await expect(fixture.host.prepareCall('gpt-6-astra')).rejects.toMatchObject({ code: 'CHATGPT_SIGN_IN_REQUIRED' })
    await expect(fixture.ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))).resolves.toMatchObject({
      payload: { status: 'needs-sign-in', email: 'person@example.test' },
    })
  })

  it('surfaces a transient refresh failure instead of degrading the grant', async () => {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, String(accountId))
    await seedAccount(fixture.ctx, accountId, { token: 'expired-token', expiresAt: 0 })
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: 'server_error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await expect(fixture.host.prepareCall('gpt-6-astra')).rejects.toThrow('ChatGPT token refresh failed')
    await expect(fixture.ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))).resolves.toMatchObject({
      payload: { status: 'connected' },
    })
  })

  it('refuses a request for a saved account that is no longer connected', async () => {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, String(accountId))
    await fixture.ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', accountId), async () => ({
      kind: 'grant',
      payload: {
        version: 1,
        accountId,
        clientId: 'c',
        subject: 's',
        createdAt: 1,
        status: 'needs-sign-in',
        grantGeneration: 0,
      },
    }))
    await expect(fixture.host.prepareCall('gpt-6-astra')).rejects.toMatchObject({ code: 'CHATGPT_SIGN_IN_REQUIRED' })
  })

  it('applies an override that changes reasoning efforts without a default', async () => {
    const fixture = await connected()
    fixture.overrides.set([{ model: 'gpt-6-astra', contextWindow: 100_000, reasoningEfforts: ['low'] }])
    vi.stubGlobal('fetch', async () => catalogResponse('Astra'))
    const resolved = await fixture.host.resolveModel('gpt-6-astra')
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['low'])
  })

  it('keeps the official reasoning efforts when only a default is overridden', async () => {
    const fixture = await connected()
    fixture.overrides.set([{ model: 'gpt-6-astra', contextWindow: 100_000, defaultReasoningEffort: 'low' }])
    vi.stubGlobal('fetch', async () => catalogResponse('Astra'))
    const resolved = await fixture.host.resolveModel('gpt-6-astra')
    expect(resolved.reasoning?.efforts.length).toBeGreaterThan(0)
    expect(resolved.reasoning?.defaultEffort).toBe('low')
  })

  it('orders several concurrent sign-in attempts', async () => {
    const path = await home()
    const fixture = await boot(path, undefined)
    const firstAccount = newAccountId()
    const secondAccount = newAccountId()
    await seedAccount(fixture.ctx, firstAccount, { token: 'first' })
    await seedAccount(fixture.ctx, secondAccount, { token: 'second' })
    const first = await fixture.host.beginLogin(firstAccount)
    const second = await fixture.host.beginLogin(secondAccount)
    const state = await fixture.host.getState()
    expect(state.loginAttempts.map(attempt => attempt.id)).toEqual(expect.arrayContaining([first.attemptId, second.attemptId]))
    await fixture.host.cancelLogin(first.attemptId)
    await fixture.host.cancelLogin(second.attemptId)
  })

  it('rejects a profile editor that does not list this plugin row', async () => {
    const path = await home()
    const fixture = await boot(path, undefined)
    fixture.ctx.provide('configEditor', { entries: () => [] } as never)
    await expect(fixture.host.acknowledgeWelcome()).rejects.toThrow('The ChatGPT plugin profile entry cannot be edited.')
  })

  it('cancels a pending sign-in for another account without touching it', async () => {
    const path = await home()
    const pendingAccount = newAccountId()
    const fixture = await boot(path, undefined)
    await seedAccount(fixture.ctx, pendingAccount, { token: 'pending-token' })
    const ticket = await fixture.host.beginLogin(pendingAccount)
    await expect(fixture.host.signOut(newAccountId())).rejects.toThrow('registration is unavailable')
    const state = await fixture.host.getState()
    expect(state.loginAttempts.map(attempt => attempt.id)).toContain(ticket.attemptId)
    await fixture.host.cancelLogin(ticket.attemptId)
  })

  it('reports a profile that cannot persist configuration', async () => {
    const path = await home()
    const fixture = await boot(path, undefined)
    await expect(fixture.host.acknowledgeWelcome()).rejects.toThrow('The active profile does not expose saved configuration editing.')
  })

  it('recreates the account request controller after sign-out and refuses the next request', async () => {
    const fixture = await connected()
    vi.stubGlobal('fetch', async () => catalogResponse('Astra'))
    await fixture.host.prepareCall('gpt-6-astra')
    await fixture.host.signOut(fixture.accountId).catch(() => undefined)
    await expect(fixture.host.prepareCall('gpt-6-astra')).rejects.toMatchObject({ code: 'CHATGPT_SIGN_IN_REQUIRED' })
  })
})

describe('ChatGPT Host callback validation', () => {
  interface CallbackHarness {
    readonly callback: (overrides?: Readonly<Record<string, string>>) => URL
    readonly redirect: string
    readonly clientId: string
    readonly state: string
    readonly attemptId: string
  }

  async function harness(
    accountId?: ChatGptAccountId,
    options: { readonly token?: (idToken: string, init?: RequestInit) => Response | Promise<Response> } = {},
  ): Promise<{ fixture: HostFixture; callback: CallbackHarness }> {
    const path = await home()
    const fixture = accountId === undefined ? await boot(path, undefined) : await boot(path, String(accountId))
    if (accountId !== undefined) await seedAccount(fixture.ctx, accountId, { token: 'valid-token' })
    const ticket = await fixture.host.beginLogin(accountId)
    const authorize = new URL(ticket.authorizationUrl)
    const redirect = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    const nonce = authorize.searchParams.get('nonce')
    const clientId = authorize.searchParams.get('client_id')
    if (redirect === null || state === null || nonce === null || clientId === null) {
      throw new Error('ChatGPT authorize request omitted a required callback value')
    }
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(publicKey)
    const idToken = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: 'ES256', kid: 'callback-key' })
      .setIssuer('https://auth.openai.com')
      .setAudience(clientId)
      .setSubject(accountId === undefined ? 'new-subject' : `subject-${accountId}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
            revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        if (options.token !== undefined) return await options.token(idToken, init)
        return new Response(
          JSON.stringify({
            access_token: 'callback-access',
            refresh_token: 'callback-refresh',
            id_token: idToken,
            token_type: 'Bearer',
            expires_in: 3_600,
            scope: scopes.join(' '),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'callback-key', alg: 'ES256', use: 'sig' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    })
    return {
      fixture,
      callback: {
        attemptId: ticket.attemptId,
        redirect,
        clientId,
        state,
        callback: (overrides = {}) => {
          const url = new URL(redirect)
          url.searchParams.set('state', state)
          url.searchParams.set('code', 'authorization-code')
          url.searchParams.set('client_id', clientId)
          for (const [key, value] of Object.entries(overrides)) url.searchParams.set(key, value)
          return url
        },
      },
    }
  }

  const nativeFetch = globalThis.fetch

  it('rejects a state that does not belong to the attempt', async () => {
    const { fixture, callback } = await harness()
    const response = await nativeFetch(callback.callback({ state: 'another-state' }))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('did not match this request')
    await fixture.host.dispose()
  })

  it('rejects a provider error and records the attempt as failed', async () => {
    const { fixture, callback } = await harness()
    const response = await nativeFetch(callback.callback({ error: 'access_denied' }))
    expect(response.status).toBe(400)
    expect((await fixture.host.getState()).loginAttempts[0]).toMatchObject({ phase: 'failed' })
    await fixture.host.dispose()
  })

  it('rejects a callback without a code or client registration', async () => {
    const { fixture, callback } = await harness()
    const missingCode = new URL(callback.redirect)
    missingCode.searchParams.set('state', callback.state)
    missingCode.searchParams.set('client_id', callback.clientId)
    expect((await nativeFetch(missingCode)).status).toBe(400)

    const emptyClient = await harness()
    expect((await nativeFetch(emptyClient.callback.callback({ client_id: '' }))).status).toBe(400)
    await emptyClient.fixture.host.dispose()
    await fixture.host.dispose()
  })

  it('rejects a reauthorization callback for another client registration', async () => {
    const accountId = newAccountId()
    const { fixture, callback } = await harness(accountId)
    const response = await nativeFetch(callback.callback({ client_id: 'client-other' }))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('did not match this registration')
    await fixture.host.dispose()
  })

  it('resets an account request controller that a prior sign-out aborted', async () => {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, String(accountId))
    await seedAccount(fixture.ctx, accountId, { token: 'valid-token' })
    await fixture.host.signOut(accountId).catch(() => undefined)
    const { callback } = await (async () => {
      const ticket = await fixture.host.beginLogin(accountId)
      const authorize = new URL(ticket.authorizationUrl)
      const redirect = authorize.searchParams.get('redirect_uri')!
      const state = authorize.searchParams.get('state')!
      const nonce = authorize.searchParams.get('nonce')!
      const clientId = authorize.searchParams.get('client_id')!
      const { privateKey, publicKey } = await generateKeyPair('ES256')
      const publicJwk = await exportJWK(publicKey)
      const idToken = await new SignJWT({ nonce })
        .setProtectedHeader({ alg: 'ES256', kid: 'reconnect-key' })
        .setIssuer('https://auth.openai.com')
        .setAudience(clientId)
        .setSubject(`subject-${accountId}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = requestUrl(input)
        if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
          return new Response(
            JSON.stringify({
              issuer: 'https://auth.openai.com',
              jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
              revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
          return new Response(
            JSON.stringify({
              access_token: 'reconnected-access',
              refresh_token: 'reconnected-refresh',
              id_token: idToken,
              token_type: 'Bearer',
              expires_in: 3_600,
              scope: scopes.join(' '),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url === 'https://auth.openai.com/.well-known/jwks.json') {
          return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'reconnect-key', alg: 'ES256', use: 'sig' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`unexpected URL: ${url}`)
      })
      const callbackUrl = new URL(redirect)
      callbackUrl.searchParams.set('state', state)
      callbackUrl.searchParams.set('code', 'authorization-code')
      callbackUrl.searchParams.set('client_id', clientId)
      return { callback: callbackUrl }
    })()
    expect((await nativeFetch(callback)).status).toBe(200)
    await fixture.host.dispose()
  })

  it('reports a token exchange failure with the provider message', async () => {
    const accountId = newAccountId()
    const { fixture, callback } = await harness(accountId)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
            revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        return new Response(JSON.stringify({ error: 'server_error' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    })
    expect((await nativeFetch(callback.callback())).status).toBe(400)
    const failed = (await fixture.host.getState()).loginAttempts[0]
    expect(failed?.phase).toBe('failed')
    expect(failed?.message).toContain('token exchange failed')
    await fixture.host.dispose()
  })

  it('refuses a reauthorization whose saved record disappeared', async () => {
    const accountId = newAccountId()
    const { fixture, callback } = await harness(accountId)
    await fixture.ctx.credentials.deleteRecord(credentialKey('dsh-chatgpt', accountId))
    expect((await nativeFetch(callback.callback())).status).toBe(400)
    await fixture.host.dispose()
  })

  it('refuses a new registration whose allocated account id was claimed before the commit', async () => {
    const path = await home()
    const { ctx, host } = await boot(path, undefined)
    const originalRead = ctx.credentials.readRecord.bind(ctx.credentials)
    let capturedId: ChatGptAccountId | undefined
    let readStarted!: () => void
    const started = new Promise<void>(resolve => {
      readStarted = resolve
    })
    let releaseRead!: () => void
    const release = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    const spy = vi.spyOn(ctx.credentials, 'readRecord').mockImplementation(async key => {
      if (capturedId === undefined && credentialKeyId(key).startsWith('account-')) {
        capturedId = credentialKeyId(key) as ChatGptAccountId
        readStarted()
        await release
        return undefined
      }
      return await originalRead(key)
    })
    try {
      const pending = host.beginLogin()
      await started
      const accountId = capturedId
      if (accountId === undefined) throw new Error('ChatGPT Host did not allocate an account id.')
      await seedAccount(ctx, accountId, { token: 'existing-token' })
      releaseRead()
      const ticket = await pending
      const authorize = new URL(ticket.authorizationUrl)
      const redirect = authorize.searchParams.get('redirect_uri')
      const state = authorize.searchParams.get('state')
      const nonce = authorize.searchParams.get('nonce')
      if (redirect === null || state === null || nonce === null) {
        throw new Error('ChatGPT authorize request omitted a callback value')
      }
      const issuedClientId = 'issued-collision-client'
      const { privateKey, publicKey } = await generateKeyPair('ES256')
      const publicJwk = await exportJWK(publicKey)
      const idToken = await new SignJWT({ nonce })
        .setProtectedHeader({ alg: 'ES256', kid: 'collision-key' })
        .setIssuer('https://auth.openai.com')
        .setAudience(issuedClientId)
        .setSubject('collision-subject')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
      const nativeFetch = globalThis.fetch
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = requestUrl(input)
        if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
          return new Response(
            JSON.stringify({
              issuer: 'https://auth.openai.com',
              jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
              revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
          return new Response(
            JSON.stringify({
              access_token: 'collision-access',
              refresh_token: 'collision-refresh',
              id_token: idToken,
              token_type: 'Bearer',
              expires_in: 3_600,
              scope: scopes.join(' '),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url === 'https://auth.openai.com/.well-known/jwks.json') {
          return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'collision-key', alg: 'ES256', use: 'sig' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`unexpected OAuth URL: ${url}`)
      })

      const callback = new URL(redirect)
      callback.searchParams.set('state', state)
      callback.searchParams.set('code', 'collision-code')
      callback.searchParams.set('client_id', issuedClientId)
      expect((await nativeFetch(callback)).status).toBe(400)
      await expect(host.waitForLogin(ticket.attemptId)).rejects.toThrow()
      await expect(ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))).resolves.toMatchObject({
        payload: { accessToken: 'existing-token' },
      })
    } finally {
      releaseRead()
      spy.mockRestore()
      await host.dispose()
    }
  })

  it('refuses a second callback while the first exchange is running', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let started!: () => void
    const exchangeStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const accountId = newAccountId()
    const { fixture, callback } = await harness(accountId, {
      token: async idToken => {
        started()
        await gate
        return new Response(
          JSON.stringify({
            access_token: 'callback-access',
            refresh_token: 'callback-refresh',
            id_token: idToken,
            token_type: 'Bearer',
            expires_in: 3_600,
            scope: scopes.join(' '),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    const first = nativeFetch(callback.callback())
    await exchangeStarted
    expect((await nativeFetch(callback.callback())).status).toBe(410)
    release()
    expect((await first).status).toBe(200)
    await fixture.host.dispose()
  })

  it('reports an interrupted sign-in when the exchange is cancelled', async () => {
    let started!: () => void
    const exchangeStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const { fixture, callback } = await harness(newAccountId(), {
      token: async (_idToken, init) => {
        started()
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            },
            { once: true },
          )
        })
      },
    })
    const pending = nativeFetch(callback.callback())
    await exchangeStarted
    await fixture.host.cancelLogin(callback.attemptId as never)
    expect((await pending).status).toBe(400)
    expect((await fixture.host.getState()).loginAttempts[0]).toMatchObject({
      phase: 'cancelled',
      message: 'ChatGPT sign-in was cancelled.',
    })
    await fixture.host.dispose()
  })

  it('answers an unsupported method or path without touching the attempt', async () => {
    const { fixture, callback } = await harness()
    const post = await nativeFetch(callback.redirect, { method: 'POST' })
    expect(post.status).toBe(405)
    const other = new URL(callback.redirect)
    other.pathname = '/other'
    expect((await nativeFetch(other)).status).toBe(404)
    await fixture.host.dispose()
  })
})

describe('ChatGPT Host account-change races', () => {
  async function connected(): Promise<HostFixture & { accountId: ChatGptAccountId }> {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, String(accountId))
    await seedAccount(fixture.ctx, accountId, { token: 'valid-token' })
    return { ...fixture, accountId }
  }

  /** Rotate the saved grant generation while the catalog request is in flight. */
  function rotateDuringCatalog(ctx: Context, accountId: ChatGptAccountId): void {
    let rotated = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (!rotated && requestUrl(input) === 'https://api.openai.com/v1/models') {
        rotated = true
        await ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', accountId), async current => {
          if (current?.kind !== 'grant' || typeof current.payload !== 'object' || current.payload === null) return current
          return { kind: 'grant', payload: { ...current.payload, grantGeneration: 1 } }
        })
      }
      return catalogResponse('Astra')
    })
  }

  it('refuses a prepared call when the grant changed during resolution', async () => {
    const fixture = await connected()
    rotateDuringCatalog(fixture.ctx, fixture.accountId)
    await expect(fixture.host.prepareCall('gpt-6-astra')).rejects.toMatchObject({ code: 'CHATGPT_ACCOUNT_CHANGED' })
  })

  it('refuses a refreshed catalog when the grant changed during the request', async () => {
    const fixture = await connected()
    rotateDuringCatalog(fixture.ctx, fixture.accountId)
    await expect(fixture.host.refreshModels(fixture.accountId)).rejects.toMatchObject({ code: 'CHATGPT_ACCOUNT_CHANGED' })
  })

  it('omits an account deleted between the listing and its record read', async () => {
    const fixture = await connected()
    const originalRead = fixture.ctx.credentials.readRecord.bind(fixture.ctx.credentials)
    let readStarted!: () => void
    const started = new Promise<void>(resolve => {
      readStarted = resolve
    })
    let releaseRead!: () => void
    const release = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    const spy = vi.spyOn(fixture.ctx.credentials, 'readRecord').mockImplementation(async key => {
      if (credentialKeyId(key) === String(fixture.accountId)) {
        readStarted()
        await release
      }
      return await originalRead(key)
    })
    try {
      const pending = fixture.host.getState()
      await started
      await fixture.ctx.credentials.deleteRecord(credentialKey('dsh-chatgpt', fixture.accountId))
      releaseRead()
      await expect(pending).resolves.toMatchObject({ accounts: [] })
    } finally {
      releaseRead()
      spy.mockRestore()
    }
  })

  it('breaks account creation-time ties by account id', async () => {
    const path = await home()
    const firstId = 'account-00000000-0000-4000-8000-000000000001' as ChatGptAccountId
    const secondId = 'account-00000000-0000-4000-8000-000000000002' as ChatGptAccountId
    const fixture = await boot(path, undefined)
    await seedAccount(fixture.ctx, secondId, { token: 'second-token', createdAt: 1 })
    await seedAccount(fixture.ctx, firstId, { token: 'first-token', createdAt: 1 })
    vi.stubGlobal('fetch', async () => catalogResponse('Astra'))

    const state = await fixture.host.getState()
    expect(state.accounts.map(account => account.id)).toEqual([firstId, secondId])
  })
})

describe('ChatGPT Host metadata permutations', () => {
  async function connected(options: { email?: string } = {}): Promise<HostFixture & { accountId: ChatGptAccountId }> {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, String(accountId))
    await seedAccount(fixture.ctx, accountId, { token: 'valid-token', ...options })
    return { ...fixture, accountId }
  }

  it('publishes the verified email and hints it during reauthorization', async () => {
    const fixture = await connected({ email: 'person@example.com' })
    vi.stubGlobal('fetch', async () => catalogResponse('Astra'))
    const state = await fixture.host.getState()
    expect(state.accounts.find(account => account.id === fixture.accountId)?.email).toBe('person@example.com')
    const ticket = await fixture.host.beginLogin(fixture.accountId)
    expect(new URL(ticket.authorizationUrl).searchParams.get('login_hint')).toBe('person@example.com')
    await fixture.host.cancelLogin(ticket.attemptId)
  })

  it('lists only bounded models and falls back to the slug for an unnamed row', async () => {
    const fixture = await connected()
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            models: [
              { slug: 'gpt-6-astra', visibility: 'list' },
              { slug: 'gpt-unbounded', visibility: 'list' },
              { slug: 'gpt-unnamed', display_name: '', visibility: 'list' },
            ],
          }),
          { status: 200 },
        ),
    )
    const state = await fixture.host.getState()
    const view = state.accounts.find(account => account.id === fixture.accountId)
    expect(view?.models.map(model => model.slug)).toEqual(['gpt-6-astra', 'gpt-unbounded', 'gpt-unnamed'])
    expect(view?.models.find(model => model.slug === 'gpt-unnamed')?.displayName).toBe('gpt-unnamed')
    expect(view?.models.find(model => model.slug === 'gpt-6-astra')?.usable).toBe(true)
    expect(view?.models.find(model => model.slug === 'gpt-unbounded')?.usable).toBe(false)
    expect(view?.models.find(model => model.slug === 'gpt-unnamed')?.usable).toBe(false)
    await expect(fixture.host.listModels()).resolves.toMatchObject([{ id: 'gpt-6-astra' }])
  })

  it('freezes override modalities and reasoning efforts into the request snapshot', async () => {
    const fixture = await connected()
    fixture.overrides.set([
      {
        model: 'gpt-6-astra',
        contextWindow: 50_000,
        inputModalities: ['text'],
        reasoningEfforts: ['low'],
        defaultReasoningEffort: 'low',
      },
    ])
    vi.stubGlobal('fetch', async () => catalogResponse('Astra'))
    await expect(fixture.host.prepareCall('gpt-6-astra')).resolves.toMatchObject({ model: { id: 'gpt-6-astra' } })
  })

  it('resolves a model and prepares a call with a caller cancellation signal', async () => {
    const fixture = await connected()
    vi.stubGlobal('fetch', async () => catalogResponse('Astra'))
    const controller = new AbortController()
    await expect(fixture.host.resolveModel('gpt-6-astra', controller.signal)).resolves.toMatchObject({ id: 'gpt-6-astra' })
    await expect(fixture.host.prepareCall('gpt-6-astra', controller.signal)).resolves.toMatchObject({ model: { id: 'gpt-6-astra' } })
  })

  it('defaults a saved record without a grant generation to zero', async () => {
    const path = await home()
    const accountId = newAccountId()
    const fixture = await boot(path, undefined)
    await fixture.ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', accountId), async () => ({
      kind: 'grant',
      payload: {
        version: 1,
        accountId,
        clientId: 'c',
        subject: 's',
        createdAt: 1,
        status: 'needs-sign-in',
      },
    }))
    const state = await fixture.host.getState()
    expect(state.accounts.map(account => account.id)).toContain(accountId)
  })

  it('merges official defaults and override-only capabilities', async () => {
    const fixture = await connected()
    fixture.overrides.set([
      { model: 'gpt-6.1-sol', defaultReasoningEffort: 'low' },
      { model: 'gpt-unbounded', contextWindow: 64_000, inputModalities: ['text', 'image'], reasoningEfforts: ['low'] },
    ])
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            models: [
              { slug: 'gpt-6-astra', visibility: 'list' },
              { slug: 'gpt-6.1-sol', visibility: 'list' },
              { slug: 'gpt-unbounded', visibility: 'list' },
            ],
          }),
          { status: 200 },
        ),
    )
    const state = await fixture.host.getState()
    const view = state.accounts.find(account => account.id === fixture.accountId)
    expect(view?.models.map(model => model.slug)).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-unbounded'])
    expect(view?.models.find(model => model.slug === 'gpt-6.1-sol')?.defaultReasoningEffort).toBe('low')
    expect(view?.models.find(model => model.slug === 'gpt-unbounded')).toMatchObject({
      contextWindow: 64_000,
      inputModalities: ['text', 'image'],
      overridden: true,
    })
  })
})
