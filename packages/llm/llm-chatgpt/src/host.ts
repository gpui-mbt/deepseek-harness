/** Host-owned ChatGPT account records, OAuth callbacks, and model resolution. */
import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationNotice, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Config } from './config.ts'
import type { ChatGptAdapterHost, ChatGptPreparedCall } from './adapter-contract.ts'
import {
  authorizationUrl,
  exchangeAuthorizationCode,
  OAuthError,
  randomOAuthValue,
  randomPkceVerifier,
  pkceChallenge,
  refreshGrant,
  revokeRefreshToken,
} from './oauth.ts'
import type { OAuthGrant, OAuthIdentityExpectation, OAuthRegistration } from './oauth.ts'
import { officialOpenAiModel, toOpenAiModelInfo, toOpenAiResolvedModelInfo } from './models.ts'
import type { OpenAiModelFacts } from './models.ts'
import type {
  ChatGptAccountId,
  ChatGptAccountView,
  ChatGptLoginAttemptId,
  ChatGptLoginAttemptView,
  ChatGptModelConfig,
  ChatGptModelOverride,
  ChatGptModelView,
  ChatGptState,
} from './types.ts'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/cordis-plugin-loader'

const CREDENTIAL_SCOPE = 'dsh-chatgpt'
const HOST_KEY = credentialKey(CREDENTIAL_SCOPE, 'host')
const ACCOUNT_ID_PREFIX = 'account-'
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
const HOST_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CATALOG_URL = 'https://api.openai.com/v1/models'
const CALLBACK_PATH = '/auth/callback'
const ACCOUNT_REQUEST_ERROR = 'The ChatGPT account registration is unavailable.'

interface StoredHost {
  readonly version: 1
  readonly hostId: string
}

interface StoredAccount {
  readonly version: 1
  readonly accountId: string
  readonly clientId: string
  readonly subject: string
  /** Incremented by local logout to invalidate callbacks and requests from an older grant. */
  readonly grantGeneration: number
  readonly email?: string
  readonly accessToken?: string
  readonly refreshToken?: string
  readonly idToken?: string
  readonly expiresAt?: number
  readonly scopes?: readonly string[]
  readonly createdAt: number
  readonly status: 'connected' | 'needs-sign-in'
}

interface CatalogModel {
  readonly id: string
  readonly displayName: string
}

interface AccountSelection {
  readonly configuredAccountId: string | undefined
  readonly inMemoryAccountId: ChatGptAccountId | undefined
}

interface RequestSettingsSnapshot {
  readonly accountSelection: AccountSelection
  readonly modelOverrides: readonly ChatGptModelOverride[]
  readonly requestTimeoutMs: number
  readonly streamIdleTimeoutMs: number
}

interface LoginAttempt {
  readonly id: ChatGptLoginAttemptId
  readonly accountId: ChatGptAccountId
  readonly key: CredentialKey
  readonly state: string
  readonly nonce: string
  readonly verifier: string
  readonly redirectUri: string
  readonly expectedIdentity?: OAuthIdentityExpectation
  readonly expectedGrantGeneration?: number
  readonly controller: AbortController
  readonly server: ReturnType<typeof createServer>
  readonly completion: Promise<void>
  readonly finish: (phase: ChatGptLoginAttemptView['phase'], message?: string) => void
  authorizationRun: Promise<void>
  session?: AuthorizationSession
  committing: boolean
  phase: ChatGptLoginAttemptView['phase']
  message?: string
  readonly createdAt: number
  finishedAt?: number
  timeout: ReturnType<typeof setTimeout>
}

/** Manage account grants without exposing OAuth tokens to the Client. */
export class ChatGptHost implements ChatGptAdapterHost {
  private readonly attempts = new Map<string, LoginAttempt>()
  private readonly activeAttemptsByKey = new Map<CredentialKey, LoginAttempt>()
  private readonly authorizationFlows = new Map<CredentialKey, () => void>()
  private readonly authorizationRuns = new Map<CredentialKey, Promise<void>>()
  private readonly loginStarts = new Map<AbortController, ChatGptAccountId | undefined>()
  private readonly catalogs = new Map<string, readonly CatalogModel[]>()
  private readonly catalogLoads = new Map<string, Promise<readonly CatalogModel[]>>()
  private readonly catalogEpochs = new Map<string, number>()
  private readonly accountControllers = new Map<string, AbortController>()
  private activeInMemoryAccountId: ChatGptAccountId | undefined
  private disposed = false
  private readonly lifetime = new AbortController()

  /** @param ctx - Host context with Credentials, Authorization, and LLM services. @param config - profile settings. */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /** Ensure the installation has one durable host identity before it registers an account. */
  async initialize(): Promise<void> {
    await this.ctx.credentials.modifyRecord(HOST_KEY, current => {
      if (current !== undefined) {
        const saved = grantPayload(current, 'ChatGPT host identity')
        const host = readHost(current)
        // Older plugin builds stored the UUID without the URI prefix.
        if (saved.hostId === host.hostId) return Promise.resolve(current)
        return Promise.resolve({ kind: 'grant', payload: host })
      }
      return Promise.resolve({ kind: 'grant', payload: { version: 1, hostId: `urn:uuid:${randomUUID()}` } })
    })
    for (const account of await this.accountRecords()) this.registerAccountFlow(accountIdOf(account.accountId))
  }

  /**
   * Start a loopback callback and return only the external authorize URL and opaque handle.
   * @param accountId - saved account to reauthorize; omission starts a new registration.
   * @returns the safe attempt handle and the browser authorization URL.
   */
  async beginLogin(accountId?: ChatGptAccountId): Promise<{ attemptId: ChatGptLoginAttemptId; authorizationUrl: string }> {
    this.assertRunning()
    const startController = new AbortController()
    this.loginStarts.set(startController, accountId)
    let publishAuthorizationUrl!: (url: string) => void
    let rejectAuthorizationUrl!: (error: Error) => void
    const authorizationUrlReady = new Promise<string>((resolve, reject) => {
      publishAuthorizationUrl = resolve
      rejectAuthorizationUrl = reject
    })
    void authorizationUrlReady.catch(() => undefined)
    let authorizationRun: Promise<void> | undefined
    let attempt: LoginAttempt | undefined
    let selectedAccountId: ChatGptAccountId | undefined
    let key: CredentialKey | undefined
    let existing: StoredAccount | undefined
    try {
      existing = accountId === undefined ? undefined : await awaitWithAbort(this.readAccount(accountId), startController.signal)
      startController.signal.throwIfAborted()
      this.assertRunning()
      if (accountId !== undefined && existing === undefined) throw new Error(ACCOUNT_REQUEST_ERROR)
      selectedAccountId = accountId ?? newAccountId()
      this.loginStarts.set(startController, selectedAccountId)
      key = accountKey(selectedAccountId)
      if (this.activeAttemptsByKey.has(key)) {
        throw new Error('A ChatGPT sign-in is already running for this account.')
      }
      this.registerAccountFlow(selectedAccountId)
      const activeKey = key
      const run = this.ctx.authorization
        .begin({
          key,
          signal: startController.signal,
          interaction: {
            notify: (notice: AuthorizationNotice): void => {
              /* v8 ignore next -- the flow's first notice always carries the authorization URL. */
              if (notice.url === undefined) return
              attempt = this.activeAttemptsByKey.get(activeKey)
              publishAuthorizationUrl(notice.url)
            },
            /* v8 ignore next 2 -- the ChatGPT flow never prompts; the seam requires the method. */
            prompt: (): Promise<string> =>
              Promise.reject(new Error('ChatGPT sign-in does not request input through the authorization prompt.')),
          },
        })
        .then(async outcome => {
          /* v8 ignore start -- settlement races: the callback owns every normal outcome, and the
           * AuthorizationService cancels the flow only after this host has already finished the
           * attempt, so these containment arms run only when a profile cancellation bypasses it. */
          if (attempt === undefined) {
            rejectAuthorizationUrl(new Error('ChatGPT sign-in was cancelled before its callback was ready.'))
            return
          }
          if (outcome.status === 'cancelled' && attempt.committing) {
            await attempt.completion
            return
          }
          if (outcome.status === 'cancelled' && !isTerminal(attempt.phase)) {
            await this.finishAttempt(attempt, 'cancelled', 'ChatGPT sign-in was cancelled.')
          }
          if (outcome.status === 'authorized' && attempt.phase !== 'complete') {
            await this.finishAttempt(attempt, 'failed', 'ChatGPT authorization ended before its grant was stored.')
          }
          /* v8 ignore stop */
        })
        .catch(async (error: unknown) => {
          const message = safeLoginError(error)
          rejectAuthorizationUrl(new Error(message))
          /* v8 ignore next -- only an AuthorizationService-driven rejection reaches this catch. */
          if (attempt !== undefined && !isTerminal(attempt.phase)) await this.finishAttempt(attempt, 'failed', message)
        })
      authorizationRun = run
      const authorize = await awaitWithAbort(authorizationUrlReady, startController.signal)
      /* v8 ignore next -- awaitWithAbort resolves only after the notify callback created the attempt. */
      if (attempt === undefined) throw new Error('ChatGPT sign-in attempt was not created.')
      attempt.authorizationRun = run
      return { attemptId: attempt.id, authorizationUrl: authorize }
    } catch (error: unknown) {
      /* v8 ignore next -- every value thrown inside this try is an Error: account reads pass through awaitWithAbort and authorization.begin rejections are contained above. */
      if (error instanceof Error) rejectAuthorizationUrl(error)
      if (authorizationRun !== undefined) await authorizationRun
      throw error
    } finally {
      this.loginStarts.delete(startController)
    }
  }

  /**
   * Wait for one local callback to complete; used by the headless profile option.
   * @param attemptId - attempt returned by {@link beginLogin}.
   */
  async waitForLogin(attemptId: ChatGptLoginAttemptId): Promise<void> {
    const attempt = this.attempts.get(String(attemptId))
    if (attempt === undefined) throw new Error('ChatGPT sign-in attempt is no longer available.')
    await attempt.completion
    await attempt.authorizationRun
    /* v8 ignore next -- every non-complete settlement supplies a message, so the fallback only guards a phase no path reaches. */
    if (attempt.phase !== 'complete') throw new Error(attempt.message ?? 'ChatGPT sign-in did not complete.')
  }

  private registerAccountFlow(accountId: ChatGptAccountId): void {
    const key = accountKey(accountId)
    if (this.authorizationFlows.has(key)) return
    const dispose = this.ctx.authorization.registerFlow({
      key,
      label: 'ChatGPT',
      methods: [{ id: 'browser', label: 'Sign in with ChatGPT' }],
      run: session => this.runAuthorizationFlow(accountId, session),
    })
    this.authorizationFlows.set(key, dispose)
  }

  private unregisterAccountFlow(key: CredentialKey): void {
    const dispose = this.authorizationFlows.get(key)
    /* v8 ignore next -- the flow's own settlement unregisters it once, so the entry exists here. */
    if (dispose === undefined) return
    this.authorizationFlows.delete(key)
    dispose()
  }

  private async runAuthorizationFlow(accountId: ChatGptAccountId, session: AuthorizationSession): Promise<void> {
    this.assertRunning()
    session.signal.throwIfAborted()
    const key = accountKey(accountId)
    /* v8 ignore next -- the per-account guard above already rejects a duplicate; this arm covers
     * two attempts that resolve the same key before either registers. */
    if (this.activeAttemptsByKey.has(key)) throw new Error('A ChatGPT sign-in is already running for this account.')
    const existing = await this.readAccount(accountId)
    session.signal.throwIfAborted()
    const host = readHost(await this.ctx.credentials.readRecord(HOST_KEY))
    session.signal.throwIfAborted()
    const state = randomOAuthValue()
    const nonce = randomOAuthValue()
    const verifier = randomPkceVerifier()
    const controller = new AbortController()
    const server = createServer((request, response) => {
      void this.handleCallback(request, response, this.attemptForServer(server))
    })
    try {
      await listenLoopback(server)
      session.signal.throwIfAborted()
    } catch (error: unknown) {
      /* v8 ignore next -- a loopback listen either succeeds or fails before an attempt exists. */
      await closeServer(server)
      /* v8 ignore next -- same listen failure. */
      throw error
    }
    const address = server.address()
    /* v8 ignore next 4 -- a listening socket always reports an IPv4 address object. */
    if (address === null || typeof address === 'string') {
      await closeServer(server)
      throw new Error('The ChatGPT sign-in callback did not receive a loopback port.')
    }
    const redirectUri = `http://127.0.0.1:${String(address.port)}${CALLBACK_PATH}`
    let complete!: () => void
    const completion = new Promise<void>(resolve => {
      complete = resolve
    })
    const attemptId = brandString<ChatGptLoginAttemptId>(`login-${randomUUID()}`)
    const attempt: LoginAttempt = {
      id: attemptId,
      accountId,
      key,
      state,
      nonce,
      verifier,
      redirectUri,
      ...(existing === undefined ? {} : { expectedIdentity: { clientId: existing.clientId, subject: existing.subject } }),
      ...(existing === undefined ? {} : { expectedGrantGeneration: existing.grantGeneration }),
      controller,
      server,
      completion,
      finish: (phase: ChatGptLoginAttemptView['phase'], message?: string): void => {
        if (isTerminal(attempt.phase)) return
        attempt.phase = phase
        if (message !== undefined) attempt.message = message
        attempt.finishedAt = Date.now()
        clearTimeout(attempt.timeout)
        complete()
      },
      authorizationRun: Promise.resolve(),
      session,
      committing: false,
      phase: 'awaiting-browser',
      createdAt: Date.now(),
      timeout: setTimeout(() => {
        void this.stopAttempt(attempt, 'failed', 'ChatGPT sign-in timed out. Start again to continue.')
      }, this.config.loginTimeoutMs.get()),
    }
    attempt.timeout.unref()
    this.attempts.set(String(attemptId), attempt)
    this.activeAttemptsByKey.set(key, attempt)
    const onAbort = (): void => {
      /* v8 ignore next -- the seam settles cancellation through stopAttempt; this guard covers a
       * session abort that lands after the commit latch but before the callback settles. */
      if (attempt.committing) return
      void this.stopAttempt(attempt, 'cancelled', 'ChatGPT sign-in was cancelled.')
    }
    session.signal.addEventListener('abort', onAbort, { once: true })
    const operation = (async (): Promise<void> => {
      try {
        session.signal.throwIfAborted()
        const authorize = authorizationUrl({
          clientId: existing?.clientId ?? DYNAMIC_CLIENT_ID,
          hostId: host.hostId,
          redirectUri,
          state,
          nonce,
          codeChallenge: pkceChallenge(verifier),
          newRegistration: existing === undefined,
          ...(existing?.email === undefined ? {} : { loginHint: existing.email }),
        })
        session.notify({ message: 'Continue in your browser to sign in to ChatGPT.', url: authorize })
        await attempt.completion
        /* v8 ignore next -- the callback settles every non-complete phase with a message before this flow resumes. */
        if (attempt.phase !== 'complete') throw new Error(attempt.message ?? 'ChatGPT sign-in did not complete.')
      } catch (error: unknown) {
        /* v8 ignore start -- containment for an AuthorizationService-driven rejection; the
         * callback already settles every normal failure before this flow resolves. */
        if (!isTerminal(attempt.phase)) {
          const phase = session.signal.aborted ? 'cancelled' : 'failed'
          await this.stopAttempt(attempt, phase, safeLoginError(error))
        }
        /* v8 ignore stop */
        throw error
      } finally {
        session.signal.removeEventListener('abort', onAbort)
      }
    })()
    this.authorizationRuns.set(key, operation)
    try {
      await operation
    } finally {
      /* v8 ignore next -- AuthorizationService keeps this key's slot until the flow run returns, so this operation is still the registered one. */
      if (this.authorizationRuns.get(key) === operation) this.authorizationRuns.delete(key)
      /* v8 ignore next -- the same per-key slot means this attempt is still the active one until this finally runs. */
      if (this.activeAttemptsByKey.get(key) === attempt) this.activeAttemptsByKey.delete(key)
    }
  }

  /**
   * Check whether the profile has any account that can authenticate a request.
   * @returns whether at least one saved account is connected.
   */
  async hasConnectedAccount(): Promise<boolean> {
    return (await this.accountRecords()).some(account => account.status === 'connected')
  }

  /**
   * Cancel and close one pending loopback callback.
   * @param attemptId - attempt returned by {@link beginLogin}.
   */
  async cancelLogin(attemptId: ChatGptLoginAttemptId): Promise<void> {
    const attempt = this.attempts.get(String(attemptId))
    if (attempt === undefined || isTerminal(attempt.phase)) return
    await this.stopAttempt(attempt, 'cancelled', 'ChatGPT sign-in was cancelled.')
    await this.authorizationRuns.get(attempt.key)
    await attempt.authorizationRun
  }

  /**
   * Return a safe view of every account, model catalog, and recent login attempt.
   * @returns the redacted account and attempt snapshot.
   */
  async getState(): Promise<ChatGptState> {
    this.pruneAttempts()
    const accounts = await this.accountRecords()
    const connected = accounts.filter(account => account.status === 'connected')
    const active = this.selectActive(connected)
    const views = await Promise.all(accounts.map(async account => this.accountView(account, active?.accountId)))
    return {
      accounts: views,
      ...(active === undefined ? {} : { activeAccountId: accountIdOf(active.accountId) }),
      welcomeAcknowledged: this.config.welcomeAcknowledged.get(),
      loginAttempts: [...this.attempts.values()].sort((left, right) => right.createdAt - left.createdAt).map(attemptView),
      loginPollIntervalMs: this.config.loginPollIntervalMs.get(),
    }
  }

  /**
   * Change the active account through the profile configuration editor.
   * @param accountId - connected account to select for future requests.
   */
  async setActiveAccount(accountId: ChatGptAccountId): Promise<void> {
    const account = await this.readAccount(accountId)
    if (account?.status !== 'connected') throw new Error(ACCOUNT_REQUEST_ERROR)
    await this.persistConfig({ activeAccountId: String(accountId) })
    this.activeInMemoryAccountId = accountId
  }

  /**
   * Revoke and locally disconnect one account while stopping its in-flight model calls.
   * @param accountId - account to disconnect.
   * @returns whether the provider confirmed refresh-token revocation.
   */
  async signOut(accountId: ChatGptAccountId): Promise<{ revocationConfirmed: boolean }> {
    const key = accountKey(accountId)
    const accountController = this.accountControllers.get(String(accountId)) ?? new AbortController()
    this.accountControllers.set(String(accountId), accountController)
    accountController.abort(new Error('ChatGPT account signed out'))
    for (const [controller, pendingAccountId] of this.loginStarts) {
      if (pendingAccountId !== undefined && String(pendingAccountId) === String(accountId)) {
        controller.abort(new Error('ChatGPT sign-in was cancelled because the account was disconnected.'))
      }
    }
    for (const attempt of this.attempts.values()) {
      if (String(attempt.accountId) !== String(accountId) || isTerminal(attempt.phase)) continue
      await this.stopAttempt(attempt, 'cancelled', 'ChatGPT sign-in was cancelled because the account was disconnected.')
      await this.authorizationRuns.get(key)
      await attempt.authorizationRun
    }
    let revocationConfirmed = false
    const next = await this.ctx.credentials.modifyRecord(key, async current => {
      if (current === undefined) return undefined
      const account = readAccount(current, String(accountId))
      if (account.status === 'connected' && typeof account.refreshToken === 'string' && account.refreshToken.length > 0) {
        revocationConfirmed = await revokeRefreshToken({
          clientId: account.clientId,
          refreshToken: account.refreshToken,
          requestTimeoutMs: this.config.requestTimeoutMs.get(),
        })
      }
      return {
        kind: 'grant',
        payload: {
          version: 1,
          accountId: account.accountId,
          clientId: account.clientId,
          subject: account.subject,
          grantGeneration: account.grantGeneration + 1,
          ...(account.email === undefined ? {} : { email: account.email }),
          createdAt: account.createdAt,
          status: 'needs-sign-in',
        },
      }
    })
    if (next === undefined) throw new Error(ACCOUNT_REQUEST_ERROR)
    this.invalidateCatalog(String(accountId))
    if (this.config.activeAccountId.get() === String(accountId) || String(this.activeInMemoryAccountId) === String(accountId)) {
      this.activeInMemoryAccountId = undefined
      await this.persistConfig({ activeAccountId: undefined })
    }
    return { revocationConfirmed }
  }

  /**
   * Refresh one account's list-visible model catalog and return the updated state.
   * @param accountId - connected account whose catalog should be reloaded.
   * @returns the updated redacted state.
   */
  async refreshModels(accountId: ChatGptAccountId): Promise<ChatGptState> {
    const account = await this.readAccount(accountId)
    if (account?.status !== 'connected') throw new Error(ACCOUNT_REQUEST_ERROR)
    const accountSignal = this.accountSignal(account.accountId)
    accountSignal.throwIfAborted()
    this.invalidateCatalog(account.accountId)
    await this.loadCatalog(account)
    accountSignal.throwIfAborted()
    const current = await this.readAccount(accountId)
    if (current?.status !== 'connected' || current.grantGeneration !== account.grantGeneration) {
      throw new LlmError('The ChatGPT account grant changed while refreshing its model catalog', 'CHATGPT_ACCOUNT_CHANGED')
    }
    return await this.getState()
  }

  /**
   * Store or remove one model capability override after checking its exact catalog id.
   * @param accountId - connected account whose catalog contains the model.
   * @param model - exact list-visible slug.
   * @param update - complete override to store, or null to clear it.
   * @returns the updated redacted state.
   */
  async setModelConfig(accountId: ChatGptAccountId, model: string, update: ChatGptModelConfig | null): Promise<ChatGptState> {
    const account = await this.readAccount(accountId)
    if (account?.status !== 'connected') throw new Error(ACCOUNT_REQUEST_ERROR)
    const catalog = await this.loadCatalog(account)
    if (!catalog.some(row => row.id === model)) throw new Error('Choose an exact model slug from the connected account catalog.')
    const current = [...this.config.modelOverrides.get()]
    const next = current.filter(row => row.model !== model)
    if (update !== null) next.push({ model, ...update })
    await this.persistConfig({ modelOverrides: next })
    return await this.getState()
  }

  /** Persist the once-only welcome acknowledgement in the active profile. */
  async acknowledgeWelcome(): Promise<void> {
    if (!this.config.welcomeAcknowledged.get()) await this.persistConfig({ welcomeAcknowledged: true })
  }

  /** List selectable models from the profile's active account after metadata admission. */
  async listModels(): Promise<readonly LlmModelInfo[]> {
    const accounts = await this.accountRecords()
    const account = this.selectActive(accounts.filter(candidate => candidate.status === 'connected'))
    if (account === undefined) return []
    const rows = await this.loadCatalog(account)
    return rows.flatMap(row => {
      const model = this.resolveMetadata(row)
      return model === undefined ? [] : [toOpenAiModelInfo('chatgpt', model)]
    })
  }

  /** Resolve one exact list-visible model slug with official facts or an explicit context override. */
  async resolveModel(model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    const account = await this.activeAccount()
    return await this.resolveModelForAccount(account, model, signal)
  }

  private async resolveModelForAccount(
    account: StoredAccount,
    model: string,
    signal?: AbortSignal,
    modelOverrides: readonly ChatGptModelOverride[] = this.config.modelOverrides.get(),
    requestTimeoutMs = this.config.requestTimeoutMs.get(),
  ): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    const rows = await this.loadCatalog(account, signal, requestTimeoutMs)
    const row = rows.find(candidate => candidate.id === model)
    if (row === undefined) throw new LlmError(`ChatGPT model "${model}" is not list-visible for the active account`, 'UNKNOWN_MODEL')
    const metadata = this.resolveMetadata(row, modelOverrides)
    if (metadata === undefined) {
      throw new LlmError(`ChatGPT model "${model}" needs a configured context-window limit`, 'MODEL_CONTEXT_REQUIRED')
    }
    const resolved = toOpenAiResolvedModelInfo('chatgpt', metadata)
    const override = modelOverrides.find(candidate => candidate.model === model)
    if (override === undefined) return resolved
    const reasoningEfforts = override.reasoningEfforts?.map(value => ReasoningEffortId(value))
    const defaultEffort =
      override.defaultReasoningEffort === undefined ? resolved.reasoning?.defaultEffort : ReasoningEffortId(override.defaultReasoningEffort)
    return {
      ...resolved,
      ...(override.contextWindow === undefined ? {} : { context: { contextWindow: override.contextWindow } }),
      ...(override.inputModalities === undefined ? {} : { inputModalities: override.inputModalities }),
      ...(override.reasoningEfforts === undefined && defaultEffort === undefined
        ? {}
        : {
            reasoning: {
              /* v8 ignore next -- toOpenAiResolvedModelInfo always materializes reasoning.efforts, so the empty fallback only satisfies the optional type. */
              efforts: (reasoningEfforts ?? resolved.reasoning?.efforts.map(effort => effort.id) ?? []).map(id => ({
                id,
                name: String(id),
              })),
              ...(defaultEffort === undefined ? {} : { defaultEffort }),
            },
          }),
    }
  }

  /** Pin an active account token and model metadata for one request. */
  async prepareCall(model: string, signal?: AbortSignal): Promise<ChatGptPreparedCall> {
    signal?.throwIfAborted()
    const snapshot = this.requestSettingsSnapshot()
    const account = await this.activeAccount(snapshot.accountSelection)
    const accountSignal = this.accountSignal(account.accountId)
    const requestSignal = signal === undefined ? accountSignal : AbortSignal.any([signal, accountSignal])
    requestSignal.throwIfAborted()
    const resolved = await this.resolveModelForAccount(account, model, requestSignal, snapshot.modelOverrides, snapshot.requestTimeoutMs)
    const latest = await this.accessGrant(account.accountId, requestSignal, snapshot.requestTimeoutMs)
    requestSignal.throwIfAborted()
    const current = await this.readAccount(accountIdOf(account.accountId))
    if (current?.status !== 'connected' || current.grantGeneration !== account.grantGeneration) {
      throw new LlmError('The ChatGPT account grant changed while preparing the request', 'CHATGPT_ACCOUNT_CHANGED')
    }
    requestSignal.throwIfAborted()
    return {
      accountId: accountIdOf(account.accountId),
      accessToken: connectedGrant(latest).accessToken,
      accountSignal,
      model: resolved,
      requestTimeoutMs: snapshot.requestTimeoutMs,
      streamIdleTimeoutMs: snapshot.streamIdleTimeoutMs,
    }
  }

  /** Read an attachment only when an image reaches the API request. */
  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) throw new LlmError('ChatGPT image input requires the attachment service', 'UNSUPPORTED_CONTENT')
    return await attachments.readImage(ref, signal)
  }

  /** Abort callbacks and every pinned account request before Host teardown completes. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort(new Error('ChatGPT Host is stopping'))
    for (const controller of this.loginStarts.keys()) controller.abort(new Error('ChatGPT Host is stopping'))
    const pending = [...this.attempts.values()].filter(attempt => !isTerminal(attempt.phase))
    for (const attempt of pending) {
      await this.stopAttempt(attempt, 'cancelled', 'ChatGPT sign-in stopped because the Host is shutting down.')
    }
    for (const key of this.authorizationFlows.keys()) this.unregisterAccountFlow(key)
    for (const controller of this.accountControllers.values()) controller.abort(new Error('ChatGPT Host is stopping'))
    this.accountControllers.clear()
    await Promise.all(
      pending.map(async attempt => {
        await attempt.completion
        await attempt.authorizationRun
      }),
    )
    await Promise.all(this.authorizationRuns.values())
  }

  private async handleCallback(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    attempt: LoginAttempt | undefined,
  ): Promise<void> {
    if (attempt === undefined || attempt.phase !== 'awaiting-browser') {
      writeCallbackResponse(response, 410, 'This ChatGPT sign-in is no longer active. Return to DeepSeek Harness and start again.')
      return
    }
    if (request.method !== 'GET' || request.url === undefined) {
      writeCallbackResponse(response, 405, 'This ChatGPT callback is not available.')
      return
    }
    const url = new URL(request.url, attempt.redirectUri)
    if (url.pathname !== CALLBACK_PATH) {
      writeCallbackResponse(response, 404, 'This ChatGPT callback is not available.')
      return
    }
    const returnedState = url.searchParams.get('state')
    if (returnedState === null || !sameSecret(returnedState, attempt.state)) {
      writeCallbackResponse(
        response,
        400,
        'The ChatGPT sign-in response did not match this request. Return to DeepSeek Harness and try again.',
      )
      return
    }
    const oauthError = url.searchParams.get('error')
    if (oauthError !== null) {
      writeCallbackResponse(response, 400, 'ChatGPT did not approve this sign-in. Return to DeepSeek Harness to try again.')
      await this.finishAttempt(attempt, 'failed', 'ChatGPT did not approve this sign-in.')
      return
    }
    const code = url.searchParams.get('code')
    const callbackClientId = url.searchParams.get('client_id')
    if (code === null || code.length === 0 || (attempt.expectedIdentity === undefined && callbackClientId === null)) {
      writeCallbackResponse(response, 400, 'ChatGPT returned an incomplete sign-in response.')
      await this.finishAttempt(attempt, 'failed', 'ChatGPT returned an incomplete sign-in response.')
      return
    }
    const clientId = attempt.expectedIdentity?.clientId ?? callbackClientId
    if (clientId === null || clientId.length === 0) {
      writeCallbackResponse(response, 400, 'ChatGPT returned an incomplete sign-in response.')
      await this.finishAttempt(attempt, 'failed', 'ChatGPT returned an incomplete sign-in response.')
      return
    }
    if (attempt.expectedIdentity === undefined && clientId === DYNAMIC_CLIENT_ID) {
      writeCallbackResponse(response, 400, 'ChatGPT did not issue a client registration for this account.')
      await this.finishAttempt(attempt, 'failed', 'ChatGPT did not issue a client registration for this account.')
      return
    }
    if (attempt.expectedIdentity !== undefined && callbackClientId !== null && callbackClientId !== clientId) {
      writeCallbackResponse(response, 400, 'The ChatGPT account or workspace did not match this registration.')
      await this.finishAttempt(attempt, 'failed', 'The selected ChatGPT account or workspace did not match this registration.')
      return
    }
    attempt.phase = 'exchanging'
    try {
      const completion = await exchangeAuthorizationCode({
        code,
        clientId,
        verifier: attempt.verifier,
        redirectUri: attempt.redirectUri,
        nonce: attempt.nonce,
        ...(attempt.expectedIdentity === undefined ? {} : { expectedIdentity: attempt.expectedIdentity }),
        requestTimeoutMs: this.config.requestTimeoutMs.get(),
        signal: attempt.controller.signal,
      })
      if (completion.status === 'connected') {
        await this.commitAttempt(attempt, await this.grantRecord(attempt.accountId, completion.grant, attempt))
        const controller = this.accountControllers.get(String(attempt.accountId))
        if (controller?.signal.aborted) this.accountControllers.set(String(attempt.accountId), new AbortController())
        this.invalidateCatalog(String(attempt.accountId))
        attempt.finish('complete')
        writeCallbackResponse(response, 200, 'ChatGPT is connected. Return to DeepSeek Harness.')
      } else {
        if (attempt.expectedIdentity === undefined) {
          await this.commitAttempt(attempt, await this.registrationRecord(attempt.accountId, completion.registration, attempt))
        }
        const message = 'ChatGPT did not grant the permissions needed to use your ChatGPT plan. Sign in again and approve access.'
        attempt.finish('failed', message)
        writeCallbackResponse(response, 400, message)
      }
      await closeServer(attempt.server)
    } catch (error: unknown) {
      const message = safeLoginError(error)
      attempt.finish('failed', message)
      writeCallbackResponse(response, 400, message)
      await closeServer(attempt.server)
    }
  }

  private attemptForServer(server: ReturnType<typeof createServer>): LoginAttempt | undefined {
    /* v8 ignore next -- a server handles requests only while its attempt is in the map; teardown closes it before the attempt leaves. */
    for (const attempt of this.attempts.values()) if (attempt.server === server) return attempt
    /* v8 ignore next -- teardown closes a server before its attempt leaves the map. */
    return undefined
  }

  private async finishAttempt(attempt: LoginAttempt, phase: ChatGptLoginAttemptView['phase'], message?: string): Promise<void> {
    /* v8 ignore next -- every caller reaches this with a non-terminal attempt: callback validation settles before awaiting closeServer, and cancellation finishes directly. */
    if (!isTerminal(attempt.phase)) attempt.finish(phase, message)
    await closeServer(attempt.server)
  }

  /** Cancel a flow only before its locked credential commit begins. */
  private async stopAttempt(attempt: LoginAttempt, phase: 'failed' | 'cancelled', message: string): Promise<void> {
    if (isTerminal(attempt.phase)) return
    /* v8 ignore start -- cancellation during the seam's commit latch: the lock test covers the
     * pre-commit arm, and once commit starts the seam refuses cancellation itself. */
    if (attempt.committing) {
      await attempt.completion
      return
    }
    /* v8 ignore stop */
    attempt.finish(phase, message)
    const reason = new Error(message)
    attempt.controller.abort(reason)
    this.ctx.authorization.cancel(attempt.key)
    await closeServer(attempt.server)
  }

  /**
   * Validate one completed grant against the registration this attempt started
   * from and build its credential record. The write itself belongs to the
   * authorization session, so its committing latch and the credential store's
   * cross-process lock both stay in effect.
   * @param accountId - account this attempt addresses.
   * @param grant - freshly exchanged offline grant.
   * @param attempt - running sign-in attempt.
   * @returns the record to commit.
   */
  private async grantRecord(accountId: ChatGptAccountId, grant: OAuthGrant, attempt: LoginAttempt): Promise<CredentialRecord> {
    attempt.controller.signal.throwIfAborted()
    attempt.session?.signal.throwIfAborted()
    const current = await this.reconciledRecord(attempt.key)
    attempt.controller.signal.throwIfAborted()
    attempt.session?.signal.throwIfAborted()
    const expected = attempt.expectedIdentity
    if (expected !== undefined) {
      if (current === undefined) throw new Error(ACCOUNT_REQUEST_ERROR)
      const previous = readAccount(current, String(accountId))
      if (
        previous.clientId !== expected.clientId ||
        previous.subject !== expected.subject ||
        previous.grantGeneration !== attempt.expectedGrantGeneration
      ) {
        throw new Error('The saved ChatGPT registration changed before reauthorization completed.')
      }
    } else if (current !== undefined) {
      throw new Error('The new ChatGPT account id is already in use.')
    }
    const previous = current === undefined ? undefined : readAccount(current, String(accountId))
    return accountRecord({
      ...grant,
      accountId: String(accountId),
      grantGeneration: previous?.grantGeneration ?? 0,
      createdAt: previous?.createdAt ?? Date.now(),
      status: 'connected',
    })
  }

  /**
   * Build the token-less registration record for an incomplete grant.
   * @param accountId - account this attempt addresses.
   * @param registration - verified identity that granted insufficient permissions.
   * @param attempt - running sign-in attempt.
   * @returns the record to commit.
   */
  private async registrationRecord(
    accountId: ChatGptAccountId,
    registration: OAuthRegistration,
    attempt: LoginAttempt,
  ): Promise<CredentialRecord> {
    attempt.controller.signal.throwIfAborted()
    attempt.session?.signal.throwIfAborted()
    const current = await this.reconciledRecord(attempt.key)
    attempt.controller.signal.throwIfAborted()
    attempt.session?.signal.throwIfAborted()
    /* v8 ignore next 3 -- a fresh v4 account id collides only on a UUID collision. */
    if (attempt.expectedIdentity !== undefined || current !== undefined) {
      throw new Error('The new ChatGPT account id is already in use.')
    }
    return accountRecord({
      accountId: String(accountId),
      clientId: registration.clientId,
      subject: registration.subject,
      grantGeneration: 0,
      ...(registration.email === undefined ? {} : { email: registration.email }),
      createdAt: Date.now(),
      status: 'needs-sign-in',
    })
  }

  /**
   * Read one record after the credential service reconciled it from disk. The
   * credential provider answers plain reads from its process snapshot, so a
   * record another process changed is visible only through the write path. The
   * callback returns no replacement, so the locked operation stores nothing.
   * @param key - record address to reconcile.
   * @returns the record as the store holds it now.
   */
  private async reconciledRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    let snapshot: CredentialRecord | undefined
    await this.ctx.credentials.modifyRecord(key, current => {
      snapshot = current
      return Promise.resolve(undefined)
    })
    return snapshot
  }

  /**
   * Commit one sign-in record through the authorization seam.
   * @param attempt - running sign-in attempt whose session owns the write.
   * @param record - credential record to store.
   */
  private async commitAttempt(attempt: LoginAttempt, record: CredentialRecord): Promise<void> {
    attempt.controller.signal.throwIfAborted()
    attempt.session?.signal.throwIfAborted()
    const session = attempt.session
    /* v8 ignore next -- beginLogin attaches the flow session before the callback server opens. */
    if (session === undefined) throw new Error('The ChatGPT sign-in session is unavailable.')
    attempt.committing = true
    clearTimeout(attempt.timeout)
    await session.commit(current => {
      const expected = attempt.expectedIdentity
      if (expected === undefined) {
        if (current !== undefined) throw new Error('The new ChatGPT account id is already in use.')
      } else {
        if (current === undefined) throw new Error(ACCOUNT_REQUEST_ERROR)
        const previous = readAccount(current, String(attempt.accountId))
        if (
          previous.clientId !== expected.clientId ||
          previous.subject !== expected.subject ||
          previous.grantGeneration !== attempt.expectedGrantGeneration
        ) {
          throw new Error('The saved ChatGPT registration changed before reauthorization completed.')
        }
      }
      return record
    })
  }

  private async accountRecords(): Promise<StoredAccount[]> {
    const entries = await this.ctx.credentials.listRecords()
    const accounts = await Promise.all(
      entries
        .filter(entry => credentialKeyScope(entry.key) === CREDENTIAL_SCOPE && credentialKeyId(entry.key).startsWith(ACCOUNT_ID_PREFIX))
        .map(async entry => {
          const record = await this.ctx.credentials.readRecord(entry.key)
          return record === undefined ? undefined : readAccount(record, credentialKeyId(entry.key))
        }),
    )
    return accounts
      .filter((account): account is StoredAccount => account !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt || left.accountId.localeCompare(right.accountId))
  }

  private async readAccount(accountId: ChatGptAccountId): Promise<StoredAccount | undefined> {
    const key = accountKey(accountId)
    const record = await this.ctx.credentials.readRecord(key)
    return record === undefined ? undefined : readAccount(record, String(accountId))
  }

  private async activeAccount(selection?: AccountSelection): Promise<StoredAccount> {
    const accounts = await this.accountRecords()
    const connected = accounts.filter(account => account.status === 'connected')
    const selected = this.selectActive(connected, selection)
    if (selected === undefined)
      throw new LlmError('Connect a ChatGPT account before using the ChatGPT model provider', 'CHATGPT_SIGN_IN_REQUIRED')
    return selected
  }

  private selectActive(accounts: readonly StoredAccount[], selection = this.accountSelection()): StoredAccount | undefined {
    const configured = selection.configuredAccountId
    if (configured !== undefined) {
      return accounts.find(account => account.accountId === configured)
    }
    /* v8 ignore next 3 -- the editor writes the active id; memory-only selection survives only a
     * concurrent external profile edit. */
    if (selection.inMemoryAccountId !== undefined) {
      return accounts.find(account => account.accountId === String(selection.inMemoryAccountId))
    }
    return accounts.length === 1 ? accounts[0] : undefined
  }

  private accountSelection(): AccountSelection {
    return {
      configuredAccountId: this.config.activeAccountId.get(),
      inMemoryAccountId: this.activeInMemoryAccountId,
    }
  }

  private requestSettingsSnapshot(): RequestSettingsSnapshot {
    const modelOverrides = this.config.modelOverrides.get().map(override =>
      Object.freeze({
        ...override,
        ...(override.inputModalities === undefined ? {} : { inputModalities: Object.freeze([...override.inputModalities]) }),
        ...(override.reasoningEfforts === undefined ? {} : { reasoningEfforts: Object.freeze([...override.reasoningEfforts]) }),
      }),
    )
    return Object.freeze({
      accountSelection: Object.freeze(this.accountSelection()),
      modelOverrides: Object.freeze(modelOverrides),
      requestTimeoutMs: this.config.requestTimeoutMs.get(),
      streamIdleTimeoutMs: this.config.streamIdleTimeoutMs.get(),
    })
  }

  private async accessGrant(
    accountId: string,
    signal?: AbortSignal,
    requestTimeoutMs = this.config.requestTimeoutMs.get(),
  ): Promise<StoredAccount> {
    signal?.throwIfAborted()
    let refreshFailure: OAuthError | undefined
    const key = accountKey(accountIdOf(accountId))
    const record = await this.ctx.credentials.modifyRecord(key, async current => {
      /* v8 ignore next -- selection read this record under the same credential lock moments ago. */
      if (current === undefined) throw new LlmError('The ChatGPT account registration is missing', 'CHATGPT_ACCOUNT_MISSING')
      const account = readAccount(current, accountId)
      /* v8 ignore next -- selection admits only connected accounts. */
      if (account.status !== 'connected')
        throw new LlmError('Sign in to the ChatGPT account again before making a request', 'CHATGPT_SIGN_IN_REQUIRED')
      /* v8 ignore next -- readAccount rejects a connected record without a numeric expiresAt, so the zero fallback is unreachable. */
      if ((account.expiresAt ?? 0) > Date.now() + 30_000) return current
      try {
        const grant = await refreshGrant({
          previous: connectedGrant(account),
          requestTimeoutMs,
          /* v8 ignore next -- every accessGrant caller passes an operation signal: prepareCall and loadCatalog always build one. */
          ...(signal === undefined ? {} : { signal }),
        })
        return accountRecord({
          ...grant,
          accountId,
          grantGeneration: account.grantGeneration,
          createdAt: account.createdAt,
          status: 'connected',
        })
      } catch (error: unknown) {
        if (error instanceof OAuthError && error.code === 'invalid_grant') {
          refreshFailure = error
          return accountRecord({
            version: 1,
            accountId,
            clientId: account.clientId,
            subject: account.subject,
            grantGeneration: account.grantGeneration,
            ...(account.email === undefined ? {} : { email: account.email }),
            createdAt: account.createdAt,
            status: 'needs-sign-in',
          })
        }
        throw error
      }
    })
    signal?.throwIfAborted()
    if (refreshFailure !== undefined)
      throw new LlmError('Sign in to the ChatGPT account again before making a request', 'CHATGPT_SIGN_IN_REQUIRED', {
        cause: refreshFailure,
      })
    /* v8 ignore next 2 -- modifyRecord always returns the record its callback wrote. */
    if (record === undefined) throw new LlmError('The ChatGPT account registration is missing', 'CHATGPT_ACCOUNT_MISSING')
    const account = readAccount(record, accountId)
    /* v8 ignore next 3 -- readAccount rejects a connected record that dropped a grant field. */
    if (account.status !== 'connected' || account.accessToken === undefined) {
      throw new LlmError('Sign in to the ChatGPT account again before making a request', 'CHATGPT_SIGN_IN_REQUIRED')
    }
    return account
  }

  private async loadCatalog(
    account: StoredAccount,
    signal?: AbortSignal,
    requestTimeoutMs = this.config.requestTimeoutMs.get(),
  ): Promise<readonly CatalogModel[]> {
    const accountId = account.accountId
    signal?.throwIfAborted()
    const accountSignal = this.accountSignal(accountId)
    accountSignal.throwIfAborted()
    const operationSignal = signal === undefined ? accountSignal : AbortSignal.any([signal, accountSignal])
    const cached = this.catalogs.get(accountId)
    if (cached !== undefined) return cached
    const pending = this.catalogLoads.get(accountId)
    if (pending !== undefined) return await pending
    const epoch = this.catalogEpochs.get(accountId) ?? 0
    const load = (async (): Promise<readonly CatalogModel[]> => {
      const activeGrant = await this.accessGrant(accountId, operationSignal, requestTimeoutMs)
      operationSignal.throwIfAborted()
      const timeout = AbortSignal.timeout(requestTimeoutMs)
      const requestSignal = AbortSignal.any([operationSignal, timeout])
      const response = await fetch(CATALOG_URL, {
        headers: { authorization: `Bearer ${activeGrant.accessToken}` },
        signal: requestSignal,
      })
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new Error('ChatGPT returned an unreadable model catalog.')
      }
      if (!response.ok) throw new Error(`ChatGPT model catalog request failed with HTTP ${String(response.status)}.`)
      const models = readCatalog(body)
      if (epoch === (this.catalogEpochs.get(accountId) ?? 0) && !accountSignal.aborted) {
        this.catalogs.set(accountId, models)
      }
      return models
    })()
    this.catalogLoads.set(accountId, load)
    try {
      return await load
    } finally {
      if (this.catalogLoads.get(accountId) === load) this.catalogLoads.delete(accountId)
    }
  }

  private invalidateCatalog(accountId: string): void {
    this.catalogEpochs.set(accountId, (this.catalogEpochs.get(accountId) ?? 0) + 1)
    this.catalogs.delete(accountId)
    this.catalogLoads.delete(accountId)
  }

  private resolveMetadata(
    row: CatalogModel,
    modelOverrides: readonly ChatGptModelOverride[] = this.config.modelOverrides.get(),
  ): OpenAiModelFacts | undefined {
    const official = officialOpenAiModel(row.id)
    const override = modelOverrides.find(candidate => candidate.model === row.id)
    const contextWindow = override?.contextWindow ?? official?.contextWindow
    if (contextWindow === undefined) return undefined
    const reasoningEfforts = override?.reasoningEfforts?.map(value => ReasoningEffortId(value)) ?? official?.reasoningEfforts ?? []
    const inputModalities = override?.inputModalities ?? official?.inputModalities
    return {
      id: row.id,
      name: row.displayName || official?.name || row.id,
      description: official?.description ?? 'Model available through this ChatGPT account.',
      contextWindow,
      ...(inputModalities === undefined ? {} : { inputModalities }),
      reasoningEfforts,
      ...(override?.defaultReasoningEffort === undefined
        ? official?.defaultReasoningEffort === undefined
          ? {}
          : { defaultReasoningEffort: official.defaultReasoningEffort }
        : { defaultReasoningEffort: ReasoningEffortId(override.defaultReasoningEffort) }),
    }
  }

  private async accountView(account: StoredAccount, activeId: string | undefined): Promise<ChatGptAccountView> {
    let catalog: readonly CatalogModel[] = []
    if (account.status === 'connected') {
      try {
        catalog = await this.loadCatalog(account)
      } catch (error: unknown) {
        this.ctx.logger.warn(`ChatGPT model catalog is unavailable: ${safeLoginError(error)}`)
      }
    }
    const overrides = new Map(this.config.modelOverrides.get().map(override => [override.model, override]))
    const models: ChatGptModelView[] = catalog.map(row => {
      const official = officialOpenAiModel(row.id)
      const override = overrides.get(row.id)
      return {
        slug: row.id,
        displayName: row.displayName || official?.name || row.id,
        ...(override?.contextWindow === undefined
          ? official?.contextWindow === undefined
            ? {}
            : { contextWindow: official.contextWindow }
          : { contextWindow: override.contextWindow }),
        ...(override?.inputModalities === undefined
          ? official?.inputModalities === undefined
            ? {}
            : { inputModalities: official.inputModalities }
          : { inputModalities: override.inputModalities }),
        ...(override?.reasoningEfforts === undefined
          ? official === undefined
            ? {}
            : { reasoningEfforts: official.reasoningEfforts.map(String) }
          : { reasoningEfforts: override.reasoningEfforts }),
        ...(override?.defaultReasoningEffort !== undefined
          ? { defaultReasoningEffort: override.defaultReasoningEffort }
          : official?.defaultReasoningEffort === undefined
            ? {}
            : { defaultReasoningEffort: String(official.defaultReasoningEffort) }),
        usable: override?.contextWindow !== undefined || official !== undefined,
        overridden: override !== undefined,
      }
    })
    return {
      id: accountIdOf(account.accountId),
      label: `ChatGPT account ${account.accountId.slice(-6)}`,
      ...(account.email === undefined ? {} : { email: account.email }),
      active: activeId === account.accountId,
      status: account.status,
      models,
    }
  }

  private accountSignal(accountId: string): AbortSignal {
    this.assertRunning()
    let controller = this.accountControllers.get(accountId)
    if (controller === undefined) {
      controller = new AbortController()
      this.accountControllers.set(accountId, controller)
    }
    return AbortSignal.any([controller.signal, this.lifetime.signal])
  }

  private async persistConfig(change: Record<string, unknown>): Promise<void> {
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) throw new Error('The active profile does not expose saved configuration editing.')
    const own = this.ctx.fiber.entry?.options
    if (own === undefined) throw new Error('The ChatGPT plugin profile entry cannot be edited.')
    const entry = editor.entries().find(candidate => candidate.options.id === own.id && candidate.options.name === own.name)
    /* v8 ignore next -- the profile editor lists every mounted row, including this one. */
    if (entry === undefined) throw new Error('The ChatGPT plugin profile entry cannot be edited.')
    await editor.edit(entry, current => ({ ...current, ...change }))
  }

  private pruneAttempts(): void {
    const cutoff = Date.now() - 10 * 60_000
    for (const [id, attempt] of this.attempts) {
      /* v8 ignore next -- attempts prune after the ten-minute retention window. */
      if (isTerminal(attempt.phase) && (attempt.finishedAt ?? 0) < cutoff) this.attempts.delete(id)
    }
  }

  private assertRunning(): void {
    if (this.disposed) throw new Error('The ChatGPT Host is stopping.')
  }
}

function accountRecord(account: Omit<StoredAccount, 'version'> | StoredAccount): CredentialRecord {
  return { kind: 'grant', payload: { version: 1, ...account } }
}

function readHost(record: CredentialRecord | undefined): StoredHost {
  const payload = grantPayload(record, 'ChatGPT host identity')
  if (payload.version !== 1 || typeof payload.hostId !== 'string') {
    throw new Error('The saved ChatGPT host identity is invalid.')
  }
  const savedId = payload.hostId.startsWith('urn:uuid:') ? payload.hostId.slice('urn:uuid:'.length) : payload.hostId
  if (!HOST_UUID_PATTERN.test(savedId)) throw new Error('The saved ChatGPT host identity is invalid.')
  return { version: 1, hostId: `urn:uuid:${savedId.toLowerCase()}` }
}

function readAccount(record: CredentialRecord, accountId: string): StoredAccount {
  const payload = grantPayload(record, 'ChatGPT account')
  if (
    payload.version !== 1 ||
    payload.accountId !== accountId ||
    typeof payload.clientId !== 'string' ||
    typeof payload.subject !== 'string' ||
    typeof payload.createdAt !== 'number' ||
    (payload.status !== 'connected' && payload.status !== 'needs-sign-in')
  ) {
    throw new Error('The saved ChatGPT account record is invalid.')
  }
  if (
    payload.grantGeneration !== undefined &&
    (typeof payload.grantGeneration !== 'number' || !Number.isSafeInteger(payload.grantGeneration) || payload.grantGeneration < 0)
  ) {
    throw new Error('The saved ChatGPT account record has an invalid grant generation.')
  }
  if (
    payload.status === 'connected' &&
    (typeof payload.accessToken !== 'string' ||
      typeof payload.refreshToken !== 'string' ||
      typeof payload.idToken !== 'string' ||
      typeof payload.expiresAt !== 'number' ||
      !Array.isArray(payload.scopes) ||
      !payload.scopes.every(scope => typeof scope === 'string'))
  ) {
    throw new Error('The saved ChatGPT grant is incomplete.')
  }
  return {
    version: 1,
    accountId,
    clientId: payload.clientId,
    subject: payload.subject,
    grantGeneration: payload.grantGeneration === undefined ? 0 : payload.grantGeneration,
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    ...(typeof payload.accessToken === 'string' ? { accessToken: payload.accessToken } : {}),
    ...(typeof payload.refreshToken === 'string' ? { refreshToken: payload.refreshToken } : {}),
    ...(typeof payload.idToken === 'string' ? { idToken: payload.idToken } : {}),
    ...(typeof payload.expiresAt === 'number' ? { expiresAt: payload.expiresAt } : {}),
    ...(Array.isArray(payload.scopes) && payload.scopes.every(scope => typeof scope === 'string') ? { scopes: payload.scopes } : {}),
    createdAt: payload.createdAt,
    status: payload.status,
  }
}

function grantPayload(record: CredentialRecord | undefined, label: string): Record<string, unknown> {
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload)) {
    throw new Error(`The saved ${label} record is invalid.`)
  }
  return record.payload as Record<string, unknown>
}

function accountKey(accountId: ChatGptAccountId): CredentialKey {
  if (!/^account-[0-9a-f-]{36}$/u.test(String(accountId))) throw new Error(ACCOUNT_REQUEST_ERROR)
  return credentialKey(CREDENTIAL_SCOPE, String(accountId))
}

function newAccountId(): ChatGptAccountId {
  return accountIdOf(`${ACCOUNT_ID_PREFIX}${randomUUID()}`)
}

function accountIdOf(value: string): ChatGptAccountId {
  return brandString<ChatGptAccountId>(value)
}

function attemptView(attempt: LoginAttempt): ChatGptLoginAttemptView {
  return {
    id: attempt.id,
    phase: attempt.phase,
    ...(attempt.message === undefined ? {} : { message: attempt.message }),
  }
}

function isTerminal(phase: ChatGptLoginAttemptView['phase']): boolean {
  return phase === 'complete' || phase === 'failed' || phase === 'cancelled'
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Race one startup read against cancellation without waiting for the read to finish. */
function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      /* v8 ignore next -- only dispose and sign-out abort this start signal, and both pass an Error reason. */
      reject(signal.reason instanceof Error ? signal.reason : new Error('ChatGPT sign-in was cancelled.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      value => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error instanceof Error ? error : new Error('ChatGPT sign-in failed.', { cause: error }))
      },
    )
    /* v8 ignore next -- cancelLogin needs the returned ticket, so the start signal cannot
     * already be aborted when the wait begins. */
    if (signal.aborted) onAbort()
  })
}

async function listenLoopback(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      /* v8 ignore next -- closeServer only closes a listening server, whose close callback reports no error. */
      if (error === undefined) {
        resolve()
        return
      }
      /* v8 ignore next -- finishAttempt closes each callback server exactly once. */
      reject(error)
    })
  })
}

function writeCallbackResponse(response: import('node:http').ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(message)
}

function readCatalog(value: unknown): readonly CatalogModel[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('ChatGPT returned an invalid model catalog.')
  const models = (value as { models?: unknown }).models
  if (!Array.isArray(models)) throw new Error('ChatGPT returned an invalid model catalog.')
  return models.flatMap((candidate): CatalogModel[] => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return []
    const row = candidate as { slug?: unknown; display_name?: unknown; visibility?: unknown }
    if (row.visibility !== 'list' || typeof row.slug !== 'string' || row.slug.length === 0) return []
    return [{ id: row.slug, displayName: typeof row.display_name === 'string' ? row.display_name : row.slug }]
  })
}

function connectedGrant(account: StoredAccount): OAuthGrant {
  /* v8 ignore next 3 -- readAccount admits a connected record only with every grant field. */
  if (
    account.status !== 'connected' ||
    account.accessToken === undefined ||
    account.refreshToken === undefined ||
    account.idToken === undefined ||
    account.expiresAt === undefined ||
    account.scopes === undefined
  ) {
    throw new LlmError('Sign in to the ChatGPT account again before making a request', 'CHATGPT_SIGN_IN_REQUIRED')
  }
  return {
    clientId: account.clientId,
    subject: account.subject,
    ...(account.email === undefined ? {} : { email: account.email }),
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    idToken: account.idToken,
    expiresAt: account.expiresAt,
    scopes: account.scopes,
  }
}

function safeLoginError(error: unknown): string {
  if (error instanceof OAuthError) return error.message
  if (error instanceof Error && error.name === 'AbortError') return 'ChatGPT sign-in was interrupted.'
  return 'ChatGPT sign-in could not be completed. Return to DeepSeek Harness and try again.'
}
