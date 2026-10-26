/**
 * ChatGPT provider page and composer plan notice, browser half.
 *
 * The page registers into the Plugins page as the official card for the
 * `chatgpt` namespace: account connection, the list-visible model catalog with
 * per-model capability overrides, and a first-connection welcome. The composer
 * dock contributes the plan status every ChatGPT-selected Session shows and the
 * usage-limit notice for the latest failed turn.
 *
 * The Remote namespace is mounted centrally by `@deepseek-ai/dsh-api-remotes`, so
 * this plugin only waits for `remote.chatgpt` and never mounts descriptors.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-llm-chatgpt/remote'
import type { ChatGptLoginAttemptId } from '@deepseek-ai/dsh-llm-chatgpt/types'
import { ChatGptSettingsSection } from './ChatGptSettingsSection.tsx'
import type { ChatGptSettingsInjected } from './ChatGptSettingsSection.tsx'
import { UsageIndicator } from './UsageIndicator.tsx'
import type { UsageIndicatorInjected } from './UsageIndicator.tsx'
import { en, zh, type ChatGptKey } from './locales.ts'
import { ChatGptUsageLimitSource } from './quota.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** ChatGPT account settings and composer plan copy. */
    chatgpt: ChatGptKey
  }
}

const NS = 'chatgpt'

/** Required services: the page slots, dictionaries, and the ChatGPT Remote namespace. */
export const inject = ['slots', 'locale', 'remote', 'remote.chatgpt', 'sessions']

/**
 * Register the ChatGPT Plugins page and the composer plan notice.
 * @param ctx - browser context carrying slots, locale, Remote, and Sessions.
 */
export function apply(ctx: Context): void {
  const attempts = new Set<ChatGptLoginAttemptId>()
  ctx.effect(() => async () => {
    await Promise.all([...attempts].map(async attemptId => {
      try {
        await ctx.remote.chatgpt.cancelLogin({ attemptId })
      } catch {
        // Host teardown may already have removed the attempt.
      }
    }))
    attempts.clear()
  }, 'ui-chatgpt: pending login attempts')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chatgpt: dictionaries')
  const t = ctx.locale.bind(NS)

  const usageLimits = new Map<SessionBinding, ChatGptUsageLimitSource>()
  ctx.effect(() => () => {
    for (const source of usageLimits.values()) source.dispose()
    usageLimits.clear()
  }, 'ui-chatgpt: usage notices')

  ctx.slots.inject('plugins.item', () =>
    ctx.slots.register(
      {
        name: 'plugins.item',
        id: 'chatgpt',
        order: 22,
        label: () => t('nav'),
        locale: NS,
        inject: (): ChatGptSettingsInjected => ({
          remote: ctx.remote.chatgpt,
          trackAttempt: id => { attempts.add(id) },
          finishAttempt: id => { attempts.delete(id) },
        }),
      },
      ChatGptSettingsSection,
    ),
  )

  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        id: 'chatgpt-usage',
        order: 2,
        locale: NS,
        inject: (sessionId): UsageIndicatorInjected => {
          const binding = ctx.sessions.binding(sessionId)
          if (binding === undefined) throw new Error(`ui-chatgpt: unknown Session "${String(sessionId)}"`)
          let usageLimit = usageLimits.get(binding)
          if (usageLimit === undefined) {
            usageLimit = new ChatGptUsageLimitSource(binding)
            usageLimits.set(binding, usageLimit)
            const source = usageLimit
            binding.ctx.effect(() => () => {
              source.dispose()
              usageLimits.delete(binding)
            }, 'ui-chatgpt: Session usage notice')
          }
          return { hooks: { usageLimit } }
        },
      },
      UsageIndicator,
    ),
  )
}
