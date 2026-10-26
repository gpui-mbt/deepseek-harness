// @vitest-environment jsdom
/** Browser wiring of the ChatGPT provider page and composer notice. */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import type { UsageIndicatorInjected } from '../src/client/UsageIndicator.tsx'

const SID = 'session-1' as SessionId

let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

async function bench() {
  const created = await SlotTestRuntime.create()
  runtime = created
  const cancelLogin = vi.fn(async (_request: { attemptId: string }) => ({ ok: true as const, value: undefined }))
  created.remote.provideNamespaces({
    chatgpt: {
      getState: async () => ({
        ok: true,
        value: {
          accounts: [],
          welcomeAcknowledged: true,
          loginAttempts: [],
          loginPollIntervalMs: 60_000,
        },
      }),
      beginLogin: async () => ({ ok: true, value: { attemptId: 'attempt-1', authorizationUrl: 'https://example.test' } }),
      cancelLogin,
      setActiveAccount: async () => ({ ok: true, value: undefined }),
      signOut: async () => ({ ok: true, value: { revocationConfirmed: true } }),
      refreshModels: async () => ({ ok: true, value: undefined }),
      setModelConfig: async () => ({ ok: true, value: undefined }),
      acknowledgeWelcome: async () => ({ ok: true, value: undefined }),
    },
  })
  const locale = new LocaleRuntime(created.ctx)
  created.ctx.provide('locale', locale)
  created.slots.installLocale(locale)
  await created.root.declare({
    'plugins.item': { kind: 'list', scope: 'root' },
    'conversation.composer.dock': { kind: 'list', scope: 'session' },
  }, () => null)
  await created.sessions.add({ id: SID })
  created.sessions.retain(SID)
  const handle = await created.mount({ inject: [...inject], apply })
  return { runtime: created, handle, cancelLogin }
}

describe('ChatGPT browser plugin', () => {
  it('registers the provider card and the composer notice', async () => {
    const { runtime, handle } = await bench()
    const card = runtime.slots.entries('plugins.item').find(entry => entry.options.id === 'chatgpt')
    expect(card).toBeDefined()
    expect(card?.options).toMatchObject({ order: 22 })
    expect(resolveSlotLabel(card?.options.label)).toBe('ChatGPT')

    const dock = runtime.slots.entries('conversation.composer.dock').find(entry => entry.options.id === 'chatgpt-usage')
    expect(dock?.options.order).toBe(2)

    await handle.dispose()
  })

  it('binds one usage-limit source per Session binding and rejects an unknown Session', async () => {
    const { runtime, handle } = await bench()
    const dock = runtime.slots.entries('conversation.composer.dock').find(entry => entry.options.id === 'chatgpt-usage')
    const injectFace = dock?.inject as ((sessionId: SessionId) => UsageIndicatorInjected) | undefined
    if (injectFace === undefined) throw new Error('the composer notice has no inject face')

    const first = injectFace(SID)
    expect(first.hooks.usageLimit.getSnapshot()).toEqual({ active: false })
    const again = injectFace(SID)
    expect(again.hooks.usageLimit).toBe(first.hooks.usageLimit)
    expect(() => injectFace('session-missing' as SessionId)).toThrow('unknown Session')

    await handle.dispose()
  })

  it('cancels tracked sign-in attempts when the plugin unloads', async () => {
    const { runtime, handle, cancelLogin } = await bench()
    const card = runtime.slots.entries('plugins.item').find(entry => entry.options.id === 'chatgpt')
    const face = (card?.inject as (() => {
      readonly remote: { readonly chatgpt: unknown }
      readonly trackAttempt: (id: string) => void
      readonly finishAttempt: (id: string) => void
    }) | undefined)?.()
    if (face === undefined) throw new Error('the provider card has no inject face')

    face.trackAttempt('attempt-1')
    face.finishAttempt('attempt-2')
    face.trackAttempt('attempt-3')
    await handle.dispose()

    expect(cancelLogin.mock.calls.map(([request]) => request.attemptId).sort())
      .toEqual(['attempt-1', 'attempt-3'])
    expect(runtime.slots.entries('plugins.item').some(entry => entry.options.id === 'chatgpt')).toBe(false)
  })
})
