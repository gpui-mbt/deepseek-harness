/** Real Loader composition: the ChatGPT row boots dormant in a base-shaped profile. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as ChatGptPlugin from '../src/index.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a base-shaped composition with the ChatGPT provider row and no account.
 * @returns the booted context and the profile patch path.
 */
async function loadComposition(): Promise<{ ctx: Context; patchPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(
    configPath,
    [
      '- id: llm',
      "  name: 'test-llm-service'",
      '- id: credentials',
      "  name: '@deepseek-ai/dsh-credentials-local'",
      '  config:',
      `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
      '    watch: false',
      '- id: authorization',
      "  name: '@deepseek-ai/dsh-authorization'",
      '- id: llm-chatgpt',
      "  name: '@deepseek-ai/dsh-llm-chatgpt'",
      '',
    ].join('\n'),
  )

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-llm-chatgpt', ChatGptPlugin],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never {
      throw new Error('unexpected module hook registration')
    },
    getOrCreateModuleJob(): never {
      throw new Error('unexpected module job creation')
    },
    resolveSync(): never {
      throw new Error('unexpected synchronous module resolution')
    },
    load(): never {
      throw new Error('unexpected module load')
    },
  }
  ctx.loader.internal = internal
  const patchPath = await profileComposition(ctx, root, configPath)
  return { ctx, patchPath }
}

describe('llm-chatgpt real dormant composition', () => {
  it('registers the ChatGPT route with no models and a readable empty state', async () => {
    const { ctx } = await loadComposition()

    expect(ctx.llm.listProviders()).toContainEqual({ id: 'chatgpt', name: 'ChatGPT' })
    await expect(ctx.llm.listModels('chatgpt')).resolves.toEqual([])

    const state = await ctx.chatgptController.getState()
    expect(state.accounts).toEqual([])
    expect(state.loginAttempts).toEqual([])
    expect(state.activeAccountId).toBeUndefined()
    expect(state.welcomeAcknowledged).toBe(false)
  })

  it('exposes every Remote operation through the mounted controller', async () => {
    const { ctx } = await loadComposition()
    const controller = ctx.chatgptController

    await expect(controller.getState()).resolves.toMatchObject({ accounts: [] })
    const ticket = await controller.beginLogin({})
    expect(ticket.authorizationUrl).toContain('https://auth.openai.com/api/accounts/authorize')
    await expect(controller.cancelLogin({ attemptId: ticket.attemptId })).resolves.toBeUndefined()
    const missing = 'account-missing' as Parameters<typeof controller.setActiveAccount>[0]['accountId']
    await expect(controller.setActiveAccount({ accountId: missing })).rejects.toThrow()
    await expect(controller.signOut({ accountId: missing })).rejects.toThrow()
    await expect(controller.refreshModels({ accountId: missing })).rejects.toThrow()
    await expect(controller.setModelConfig({
      accountId: missing,
      model: 'gpt-6-sol',
      config: { contextWindow: 100_000, inputModalities: ['text'] },
    })).rejects.toThrow()
    await expect(controller.acknowledgeWelcome()).resolves.toBeUndefined()
  })

  it('persists the active account, catalog overrides, and welcome through the profile editor', async () => {
    const { ctx } = await loadComposition()
    const accountId = `account-${randomUUID()}` as Parameters<typeof ctx.chatgptController.setActiveAccount>[0]['accountId']
    await ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', String(accountId)), async () => ({
      kind: 'grant',
      payload: {
        version: 1,
        accountId,
        clientId: 'client-composition',
        subject: 'subject-composition',
        grantGeneration: 0,
        accessToken: 'composition-access',
        refreshToken: 'composition-refresh',
        idToken: 'composition-id',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
        createdAt: Date.now(),
        status: 'connected',
      },
    }))
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      models: [{ slug: 'gpt-6-astra', display_name: 'Astra', visibility: 'list' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(ctx.chatgptController.setActiveAccount({ accountId })).resolves.toBeUndefined()
    const refreshed = await ctx.chatgptController.refreshModels({ accountId })
    expect(refreshed.activeAccountId).toBe(accountId)
    await expect(ctx.chatgptController.setModelConfig({
      accountId,
      model: 'gpt-6-astra',
      config: { contextWindow: 200_000, inputModalities: ['text'] },
    })).resolves.toMatchObject({ activeAccountId: accountId })
    await expect(ctx.chatgptController.setModelConfig({ accountId, model: 'gpt-6-astra', config: null }))
      .resolves.toBeDefined()
    await expect(ctx.chatgptController.setModelConfig({ accountId, model: 'gpt-6-missing', config: null }))
      .rejects.toThrow('Choose an exact model slug')
    await expect(ctx.chatgptController.acknowledgeWelcome()).resolves.toBeUndefined()
    await expect(ctx.chatgptController.acknowledgeWelcome()).resolves.toBeUndefined()
    await expect(ctx.llm.listModels('chatgpt')).resolves.toContainEqual(
      expect.objectContaining({ id: 'gpt-6-astra' }),
    )
  })

  it('rejects account mutations for an id with no connected record', async () => {
    const { ctx } = await loadComposition()
    const missing = `account-${randomUUID()}` as Parameters<typeof ctx.chatgptController.setActiveAccount>[0]['accountId']
    await expect(ctx.chatgptController.setActiveAccount({ accountId: missing }))
      .rejects.toThrow('registration is unavailable')
    await expect(ctx.chatgptController.setModelConfig({ accountId: missing, model: 'gpt-6-astra', config: null }))
      .rejects.toThrow('registration is unavailable')
    await expect(ctx.chatgptController.refreshModels({ accountId: missing }))
      .rejects.toThrow('registration is unavailable')
  })

  it('leaves the host identity record in place after unload', async () => {
    const { ctx } = await loadComposition()
    const record = await ctx.credentials.readRecord(credentialKey('dsh-chatgpt', 'host'))
    expect(record).toMatchObject({ kind: 'grant', payload: { version: 1 } })
  })
})
