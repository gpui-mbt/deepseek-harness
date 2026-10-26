/**
 * ChatGPT subscription inference: a Host-owned account directory, the
 * Sign-in-with-ChatGPT authorization flow, and one Responses API provider route.
 *
 * The row mounts dormant: it registers the `chatgpt` provider route immediately,
 * while the route advertises no models until one saved account is connected. The
 * browser half of the product is `@deepseek-ai/dsh-client-ui-chatgpt`, and its
 * Remote namespace is mounted centrally by `@deepseek-ai/dsh-api-remotes`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { assertModelOverrides, type Config } from './config.ts'
import { ChatGptHost } from './host.ts'
import { ChatGptResponsesAdapter } from './responses.ts'
import type {
  ChatGptAccountRequest, ChatGptCancelLoginRequest, ChatGptLoginRequest, ChatGptLoginTicket,
  ChatGptModelConfigUpdate, ChatGptSignOutResult, ChatGptState,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Profile-scoped ChatGPT account and catalog operations. */
    chatgptController: ChatGptController
  }
}

export type * from './types.ts'
export { Config } from './config.ts'
export { ChatGptHost } from './host.ts'
export { ChatGptResponsesAdapter } from './responses.ts'
export type { ChatGptResponsesAdapterOptions } from './responses.ts'

/** Package name shown in plugin diagnostics. */
export const name = '@deepseek-ai/dsh-llm-chatgpt'

/** The Host needs durable credentials, authorization flows and the model-adapter registry. */
export const inject = ['credentials', 'authorization', 'llm']

/** Typed Remote operations for profile ChatGPT accounts, catalogs and sign-in. */
export class ChatGptController extends TypertRemoteService {
  static inject = ['credentials', 'llm']

  /**
   * @param ctx - Host context carrying the Credentials and LLM services.
   * @param host - account lifecycle owner.
   */
  constructor(ctx: Context, private readonly host: ChatGptHost) {
    super(ctx, 'chatgptController', { namespace: 'chatgpt' })
  }

  /**
   * Read account, catalog and sign-in state without exposing credentials.
   * @returns the redacted account and OAuth-attempt snapshot.
   */
  @Remote
  getState(): Promise<ChatGptState> {
    return this.host.getState()
  }

  /**
   * Start a Host-owned OAuth callback and return the URL for the system browser.
   * @param request - a saved account for reauthorization, or an empty request for a new registration.
   * @returns the safe attempt handle and authorization URL.
   */
  @Remote
  beginLogin(request: ChatGptLoginRequest): Promise<ChatGptLoginTicket> {
    return this.host.beginLogin(request.accountId)
  }

  /**
   * Cancel an unfinished local sign-in attempt.
   * @param request - opaque attempt handle returned by {@link beginLogin}.
   */
  @Remote
  cancelLogin(request: ChatGptCancelLoginRequest): Promise<void> {
    return this.host.cancelLogin(request.attemptId)
  }

  /**
   * Select the profile's ChatGPT account for future model requests.
   * @param request - the saved account to activate.
   */
  @Remote
  setActiveAccount(request: ChatGptAccountRequest): Promise<void> {
    return this.host.setActiveAccount(request.accountId)
  }

  /**
   * Remove an account and revoke its refresh token when possible.
   * @param request - account to disconnect.
   * @returns whether OpenAI confirmed token revocation.
   */
  @Remote
  signOut(request: ChatGptAccountRequest): Promise<ChatGptSignOutResult> {
    return this.host.signOut(request.accountId)
  }

  /**
   * Refresh one saved account's list-visible model catalog.
   * @param request - account whose catalog should be refreshed.
   * @returns the updated redacted state.
   */
  @Remote
  refreshModels(request: ChatGptAccountRequest): Promise<ChatGptState> {
    return this.host.refreshModels(request.accountId)
  }

  /**
   * Store or clear one profile capability override.
   * @param update - exact account catalog slug and its replacement override.
   * @returns updated redacted state.
   */
  @Remote
  setModelConfig(update: ChatGptModelConfigUpdate): Promise<ChatGptState> {
    return this.host.setModelConfig(update.accountId, update.model, update.config)
  }

  /** Remember that a Client has shown the initial account welcome view. */
  @Remote
  acknowledgeWelcome(): Promise<void> {
    return this.host.acknowledgeWelcome()
  }
}

/**
 * Register the ChatGPT adapter and profile account service.
 * @param ctx - Host context carrying Credentials, Authorization and LLM.
 * @param config - validated profile configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  assertModelOverrides(config.modelOverrides.get())
  const host = new ChatGptHost(ctx, config)
  const adapterDisposal: { dispose?: () => void } = {}
  ctx.effect(() => async () => {
    adapterDisposal.dispose?.()
    await host.dispose()
  })
  await host.initialize()
  await ctx.plugin(ChatGptController, host)
  adapterDisposal.dispose = ctx.llm.registerAdapter(['chatgpt'], new ChatGptResponsesAdapter(host))
  if (config.authorizeOnStart.get() && !(await host.hasConnectedAccount())) {
    const ticket = await host.beginLogin()
    ctx.logger.info(`ChatGPT sign-in requires a local browser. Open this URL, approve access, and wait for the callback: ${ticket.authorizationUrl}`)
    await host.waitForLogin(ticket.attemptId)
  }
}
