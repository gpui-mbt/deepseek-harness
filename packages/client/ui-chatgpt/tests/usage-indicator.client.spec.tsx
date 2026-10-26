// @vitest-environment jsdom
/** Composer plan status and usage-limit action. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { UsageIndicator, type UsageIndicatorProps } from '../src/client/UsageIndicator.tsx'
import type { ChatGptUsageLimitSnapshot } from '../src/client/quota.ts'
import { en } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

const neverCalled = (): never => { throw new Error('Unexpected UI selector call') }

afterEach(cleanup)

function renderUsageIndicator(active: boolean, provider?: string) {
  const selection = provider === undefined ? undefined : {
    next: { provider, model: 'gpt-model' },
    lastUsed: null,
  }
  const props = {
    sessionId: brandString<SessionId>('session-1'),
    useSessions: neverCalled,
    useSessionStatus: neverCalled,
    useSessionRetainInfo: neverCalled,
    useSession: neverCalled,
    useProjection: () => selection,
    useUsageLimit: selector => selector({ active } satisfies ChatGptUsageLimitSnapshot),
    t: ((key: string) => Object.entries(en).find(([candidate]) => candidate === key)?.[1] ?? key) as PropsLocale<'chatgpt'>['t'],
  } as UsageIndicatorProps
  return render(<UsageIndicator {...props} />)
}

describe('ChatGPT composer usage indicator', () => {
  it('offers Manage usage as the primary action for the matching limit event', () => {
    renderUsageIndicator(true)

    expect(screen.getByRole('alert').textContent).toContain(en.usageLimitTitle)
    const manage = screen.getByRole('link', { name: en.manageUsage })
    expect(manage.getAttribute('href')).toBe('https://chatgpt.com/settings/usage')
    expect(manage.getAttribute('target')).toBe('_blank')
    expect(manage.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('shows the selected ChatGPT plan and usage link under the composer', () => {
    renderUsageIndicator(false, 'chatgpt')

    expect(screen.getByText(en.usingPlan)).toBeTruthy()
    expect(screen.getByRole('link', { name: en.manageUsage }).getAttribute('href'))
      .toBe('https://chatgpt.com/settings/usage')
  })

  it('does not show a plan notice for another provider without a matching quota event', () => {
    renderUsageIndicator(false, 'other')

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('link', { name: en.manageUsage })).toBeNull()
  })
})
