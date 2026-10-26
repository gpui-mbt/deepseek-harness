/** Plan status and request-scoped usage-limit action under the composer. */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { ChatGptUsageLimitSnapshot } from './quota.ts'
import css from './UsageIndicator.module.css'

/** The only Client-owned hook supplied to the composer notice. */
export interface UsageIndicatorInjected {
  hooks: {
    /** The current Session's most recent matching ChatGPT plan-limit failure. */
    usageLimit: import('@deepseek-ai/dsh-client-store').ObservableSnapshot<ChatGptUsageLimitSnapshot>
  }
}

/** Props the composer dock binds for the plan notice. */
export type UsageIndicatorProps = PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'chatgpt'>
  & InjectFace<UsageIndicatorInjected>

const USAGE_URL = 'https://chatgpt.com/settings/usage'

/** Show plan management only for a ChatGPT-selected Session or its quota failure.
 * @param props - Session projections, usage state, and localized copy.
 * @returns a composer plan status or usage-limit action.
 */
export function UsageIndicator(props: UsageIndicatorProps): ReactNode {
  const { useProjection, useUsageLimit, t } = props
  const selection = useProjection('modelSelection')
  const quota = useUsageLimit(value => value)
  const usingChatGpt = (selection?.next ?? selection?.lastUsed)?.provider === 'chatgpt'
  if (quota.active) {
    return <aside className={css.limit} role="alert" aria-live="assertive">
      <div className={css.copy}>
        <strong>{t('usageLimitTitle')}</strong>
        <span>{t('usageLimitDescription')}</span>
      </div>
      <a className={css.manage} href={USAGE_URL} target="_blank" rel="noopener noreferrer">{t('manageUsage')}</a>
    </aside>
  }
  if (!usingChatGpt) return null
  return <div className={css.plan}>
    <span>{t('usingPlan')}</span>
    <a href={USAGE_URL} target="_blank" rel="noopener noreferrer">{t('manageUsage')}</a>
  </div>
}
