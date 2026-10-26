/**
 * Dots page, browser half: the `main` page and its Sidebar entry.
 *
 * The page reads and mutates durable dots exclusively through the `dots`
 * Remote namespace. Single-host deployments have no host selector, model
 * picker, or "open host" action, so creation uses the deployment defaults and a
 * dot's home Session opens in the current window through `uiWorkspace`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-dots/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DotsIcon } from './DotsIcon.tsx'
import { DotsPanel } from './DotsPanel.tsx'
import type { DotsPanelInjected } from './DotsPanel.tsx'
import { en, zh, type DotsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Dots page and Sidebar entry copy. */
    dots: DotsKey
  }
}

const NS = 'dots'

const PANEL_ID = 'dots' as MainPanelId

/** Required services: slots, dictionaries, the dots Remote namespace, and Session navigation. */
export const inject = ['slots', 'locale', 'remote', 'remote.dots', 'uiWorkspace']

/**
 * Register the Dots page and its Sidebar entry.
 * @param ctx - browser context carrying slots, locale, Remote, and Workspace navigation.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-dots: dictionaries')
  const t = ctx.locale.bind(NS)
  const injected = (): DotsPanelInjected => ({
    remote: ctx.remote.dots,
    // The dot record carries its home Session id as a plain wire string.
    openSession: sessionId => { ctx.uiWorkspace.openSession(sessionId as SessionId) },
  })

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: injected,
      },
      DotsPanel,
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        locale: NS,
        label: () => t('panel'),
      },
      DotsIcon,
    ),
  )
}
