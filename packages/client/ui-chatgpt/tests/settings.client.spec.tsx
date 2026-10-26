// @vitest-environment jsdom
/** Client sign-in reauthentication and first-use welcome behavior. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ChatGptAccountId, ChatGptAccountView, ChatGptLoginAttemptId, ChatGptModelView, ChatGptState,
} from '@deepseek-ai/dsh-llm-chatgpt/types'
import { ChatGptSettingsSection, type ChatGptRemote, type ChatGptSettingsProps } from '../src/client/ChatGptSettingsSection.tsx'
import { en } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

const t: PropsLocale<'chatgpt'>['t'] = key => (en as Readonly<Record<string, string>>)[key] ?? key

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const React = await import('react')
  interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    readonly icon?: ReactNode
    readonly variant?: string
    readonly size?: string
  }
  interface ModalProps {
    readonly open: boolean
    readonly title: string
    readonly description?: string
    readonly closeLabel: string
    readonly onClose: () => void
    readonly footer?: ReactNode
    readonly children?: ReactNode
  }
  return {
    Button: ({ icon, variant: _variant, size: _size, children, ...props }: ButtonProps) =>
      React.createElement('button', { ...props, type: 'button' }, icon, children),
    Modal: ({ open, title, description, closeLabel, onClose, footer, children }: ModalProps) => open
      ? React.createElement('div', { role: 'dialog', 'aria-label': title },
        React.createElement('h2', {}, title),
        description === undefined ? null : React.createElement('p', {}, description),
        children,
        footer,
        React.createElement('button', { type: 'button', onClick: onClose }, closeLabel))
      : null,
  }
})

const success = <T,>(value: T): RemoteResult<T> => ({ ok: true, value })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const accountId = brandString<ChatGptAccountId>('account-1')
const account: ChatGptAccountView = {
  id: accountId,
  label: 'Personal account',
  email: 'person@example.com',
  active: true,
  status: 'connected',
  models: [],
}

function state(overrides: Partial<ChatGptState> = {}): ChatGptState {
  return {
    accounts: [],
    welcomeAcknowledged: true,
    loginAttempts: [],
    loginPollIntervalMs: 60_000,
    ...overrides,
  }
}

function remoteFor(getState: () => Promise<ChatGptState>): ChatGptRemote {
  return {
    getState: vi.fn(async () => success(await getState())),
    beginLogin: vi.fn(async () => success({
      attemptId: brandString<ChatGptLoginAttemptId>('attempt-1'),
      authorizationUrl: 'https://auth.openai.com/oauth/authorize',
    })),
    cancelLogin: vi.fn(async () => success(undefined)),
    setActiveAccount: vi.fn(async () => success(undefined)),
    signOut: vi.fn(async () => success({ revocationConfirmed: true })),
    refreshModels: vi.fn(async () => success(state())),
    setModelConfig: vi.fn(async () => success(state())),
    acknowledgeWelcome: vi.fn(async () => success(undefined)),
  }
}

function mount(remote: ChatGptRemote, view: 'page' | 'summary' = 'page', overrides: Partial<ChatGptSettingsProps> = {}) {
  const props = {
    view,
    remote,
    trackAttempt: vi.fn(),
    finishAttempt: vi.fn(),
    t,
    ...overrides,
  } as ChatGptSettingsProps
  return { ...render(<ChatGptSettingsSection {...props} />), finishAttempt: props.finishAttempt }
}

describe('ChatGptSettingsSection', () => {
  it('reauthenticates the selected saved registration instead of adding an account', async () => {
    const saved = { ...account, status: 'needs-sign-in' as const }
    const remote = remoteFor(async () => state({ accounts: [saved], activeAccountId: saved.id }))
    vi.spyOn(window, 'open').mockReturnValue(null)
    mount(remote)
    await screen.findByText(en.signInRequired)

    const signInButtons = screen.getAllByRole('button', { name: en.continueWithChatGPT })
    expect(signInButtons).toHaveLength(2)
    fireEvent.click(signInButtons[1]!)

    await waitFor(() => { expect(remote.beginLogin).toHaveBeenCalledExactlyOnceWith({ accountId: saved.id }) })
  })

  it('shows a generic sign-in failure without exposing Remote error details', async () => {
    const remote = remoteFor(async () => state())
    vi.mocked(remote.beginLogin).mockResolvedValue({
      ok: false,
      error: new RemoteError('gateway/internal', 'access_token=private-value', {}),
    })
    vi.spyOn(window, 'open').mockReturnValue(null)
    mount(remote)

    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))

    expect((await screen.findByRole('alert')).textContent).toContain(en.actionFailed)
    expect(document.body.textContent).not.toContain('private-value')
  })

  it('cancels a pending local sign-in when the settings view is disposed', async () => {
    const attemptId = brandString<ChatGptLoginAttemptId>('attempt-1')
    const remote = remoteFor(async () => state())
    vi.mocked(remote.beginLogin).mockResolvedValue(success({
      attemptId,
      authorizationUrl: 'https://auth.openai.com/oauth/authorize',
    }))
    vi.spyOn(window, 'open').mockReturnValue(null)
    const view = mount(remote)

    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    await waitFor(() => { expect(remote.beginLogin).toHaveBeenCalledOnce() })
    view.unmount()

    await waitFor(() => { expect(remote.cancelLogin).toHaveBeenCalledExactlyOnceWith({ attemptId }) })
  })

  it.each([
    { phase: 'failed' as const, label: en.loginFailed },
    { phase: 'cancelled' as const, label: en.loginCancelled },
  ])('stops polling after a sign-in becomes $phase', async ({ phase, label }) => {
    const attemptId = brandString<ChatGptLoginAttemptId>('attempt-1')
    const pending = { id: attemptId, phase: 'awaiting-browser' as const }
    let reads = 0
    const remote = remoteFor(async () => {
      reads += 1
      return reads === 1
        ? state({ loginAttempts: [pending], loginPollIntervalMs: 20 })
        : state({ loginAttempts: [{ id: attemptId, phase, message: 'Sign-in ended.' }], loginPollIntervalMs: 20 })
    })
    vi.useFakeTimers()
    try {
      mount(remote)
      await act(async () => { await Promise.resolve() })
      expect(screen.getByText(en.loginWaiting)).toBeTruthy()

      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      expect(screen.getByText(label)).toBeTruthy()
      expect(remote.getState).toHaveBeenCalledTimes(2)

      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(remote.getState).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('switches the profile account used by future ChatGPT requests', async () => {
    const secondId = brandString<ChatGptAccountId>('account-2')
    const second: ChatGptAccountView = {
      ...account,
      id: secondId,
      label: 'Work account',
      email: 'work@example.com',
      active: false,
    }
    let current = state({ accounts: [account, second], activeAccountId: account.id })
    const remote = remoteFor(async () => current)
    vi.mocked(remote.setActiveAccount).mockImplementation(async request => {
      current = state({
        accounts: [
          { ...account, active: request.accountId === account.id },
          { ...second, active: request.accountId === second.id },
        ],
        activeAccountId: request.accountId,
      })
      return success(undefined)
    })
    mount(remote)
    const select = await screen.findByRole('combobox', { name: en.activeAccount })

    fireEvent.change(select, { target: { value: second.id } })

    await waitFor(() => { expect(remote.setActiveAccount).toHaveBeenCalledExactlyOnceWith({ accountId: second.id }) })
    await waitFor(() => { expect((select as HTMLSelectElement).value).toBe(second.id) })
  })

  it('shows the welcome once after an account connects and persists dismissal', async () => {
    let current = state({ accounts: [account], activeAccountId: account.id, welcomeAcknowledged: false })
    const remote = remoteFor(async () => current)
    vi.mocked(remote.acknowledgeWelcome).mockImplementation(async () => {
      current = { ...current, welcomeAcknowledged: true }
      return success(undefined)
    })
    mount(remote)

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(en.welcomeDescription)
    expect(dialog.querySelector(`a[href="https://chatgpt.com/settings/usage"]`)?.textContent).toBe(en.manageUsage)
    fireEvent.click(screen.getByRole('button', { name: en.continue }))

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(remote.acknowledgeWelcome).toHaveBeenCalledOnce()
    expect(current.welcomeAcknowledged).toBe(true)
  })

  it('requires a context window before saving an unlisted model override', async () => {
    const unknownModel = {
      slug: 'gpt-future-model',
      displayName: 'A future model with a deliberately long display name',
      usable: false,
      overridden: false,
    }
    let current = state({
      accounts: [{ ...account, models: [unknownModel] }],
      activeAccountId: account.id,
    })
    const remote = remoteFor(async () => current)
    vi.mocked(remote.setModelConfig).mockImplementation(async update => {
      current = state({
        accounts: [{
          ...account,
          models: [{ ...unknownModel, contextWindow: update.config?.contextWindow, usable: true, overridden: true }],
        }],
        activeAccountId: account.id,
      })
      return success(current)
    })
    mount(remote)

    await screen.findByText(unknownModel.displayName)
    expect(screen.getByText(en.modelNeedsContext)).toBeTruthy()
    expect(screen.getByText(en.contextWindowRequired)).toBeTruthy()
    const save = screen.getByRole('button', { name: en.save }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.change(screen.getByRole('spinbutton', { name: en.contextWindow }), { target: { value: '98304' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => {
      expect(remote.setModelConfig).toHaveBeenCalledExactlyOnceWith({
        accountId: account.id,
        model: unknownModel.slug,
        config: { contextWindow: 98304, inputModalities: ['text'] },
      })
    })
  })

  it('rejects a non-positive context window before saving', async () => {
    const remote = remoteFor(async () => state({
      accounts: [accountWith([modelView({ contextWindow: 1000 })])],
      activeAccountId: accountId,
    }))
    mount(remote)
    fireEvent.click(await screen.findByText('Astra'))

    fireEvent.change(screen.getByLabelText(en.contextWindow), { target: { value: '0' } })

    expect(screen.getByText(en.contextWindowRequired)).toBeDefined()
    expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(true)
  })

  it('signs out without a revocation warning when OpenAI confirms revocation', async () => {
    const remote = remoteFor(async () => state({ accounts: [accountWith([])], activeAccountId: accountId }))
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.signOut }))
    const dialog = await screen.findByRole('dialog', { name: en.confirmSignOut })
    fireEvent.click(within(dialog).getByRole('button', { name: en.confirm }))

    await waitFor(() => { expect(remote.signOut).toHaveBeenCalledWith({ accountId }) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(screen.queryByText(en.signOutRevocationUnconfirmed)).toBeNull()
  })

  it('leaves the active account unchanged when a non-connected option is chosen', async () => {
    const pending = {
      ...account,
      id: brandString<ChatGptAccountId>('account-2'),
      label: 'Work account',
      email: 'work@example.com',
      active: false,
      status: 'needs-sign-in' as const,
    }
    const remote = remoteFor(async () => state({ accounts: [account, pending], activeAccountId: account.id }))
    mount(remote)
    const select = await screen.findByRole('combobox', { name: en.activeAccount })

    fireEvent.change(select, { target: { value: pending.id } })
    await act(async () => { await Promise.resolve() })

    expect(remote.setActiveAccount).not.toHaveBeenCalled()
  })

  it('shows the exchange phase for a sign-in that is finishing', async () => {
    const attempt = { id: brandString<ChatGptLoginAttemptId>('attempt-exchanging'), phase: 'exchanging' as const }
    mount(remoteFor(async () => state({
      accounts: [accountWith([])],
      activeAccountId: accountId,
      loginAttempts: [attempt],
    })))

    expect(await screen.findByText(en.loginExchanging)).toBeDefined()
  })
})

const modelBase: ChatGptModelView = {
  slug: 'gpt-6-astra',
  displayName: 'Astra',
  usable: false,
  overridden: false,
}

function modelView(overrides: Partial<ChatGptModelView> = {}): ChatGptModelView {
  return { ...modelBase, ...overrides }
}

function accountWith(models: readonly ChatGptModelView[]): ChatGptAccountView {
  return { ...account, models }
}

describe('ChatGptSettingsSection interactions', () => {
  it('renders the Plugins-page one-liner in summary view', () => {
    mount(remoteFor(async () => state()), 'summary')
    expect(document.body.textContent).toBe(en.summary)
  })

  it('marks a registration that still needs an issued client', async () => {
    const { email: _email, ...withoutEmail } = account
    const pending = { ...withoutEmail, status: 'needs-registration' as const }
    mount(remoteFor(async () => state({ accounts: [pending], activeAccountId: pending.id })))
    expect(await screen.findByText(en.registrationRequired)).toBeDefined()
  })

  it('saves context, modalities, reasoning efforts, and a default effort', async () => {
    const remote = remoteFor(async () => state({ accounts: [accountWith([modelView()])], activeAccountId: accountId }))
    mount(remote)
    fireEvent.click(await screen.findByText('Astra'))
    fireEvent.change(screen.getByLabelText(en.contextWindow), { target: { value: '128000' } })
    fireEvent.click(screen.getByLabelText(en.imageInput))
    fireEvent.change(screen.getByLabelText(en.reasoningEfforts), { target: { value: 'low, high' } })
    fireEvent.change(screen.getByLabelText(en.defaultReasoningEffort), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => {
      expect(remote.setModelConfig).toHaveBeenCalledWith({
        accountId,
        model: 'gpt-6-astra',
        config: {
          contextWindow: 128_000,
          inputModalities: ['text', 'image'],
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
        },
      })
    })
  })

  it('clears an override, disables invalid saves, and explains each validation failure', async () => {
    const remote = remoteFor(async () => state({
      accounts: [accountWith([modelView({ contextWindow: 200_000, overridden: true, reasoningEfforts: ['low'] })])],
      activeAccountId: accountId,
    }))
    mount(remote)
    fireEvent.click(await screen.findByText('Astra'))

    const save = screen.getByRole('button', { name: en.save })
    fireEvent.change(screen.getByLabelText(en.contextWindow), { target: { value: '' } })
    expect(screen.getByText(en.contextWindowRequired)).toBeDefined()
    expect(save.hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByLabelText(en.contextWindow), { target: { value: '1000' } })
    fireEvent.click(screen.getByLabelText(en.textInput))
    expect(screen.getByText(en.inputTypeRequired)).toBeDefined()
    fireEvent.click(screen.getByLabelText(en.textInput))

    fireEvent.change(screen.getByLabelText(en.defaultReasoningEffort), { target: { value: 'medium' } })
    expect(screen.getByText(en.reasoningDefaultUnavailable)).toBeDefined()
    fireEvent.change(screen.getByLabelText(en.defaultReasoningEffort), { target: { value: 'low' } })

    fireEvent.click(screen.getByRole('button', { name: en.resetModel }))
    await waitFor(() => {
      expect(remote.setModelConfig).toHaveBeenCalledWith({ accountId, model: 'gpt-6-astra', config: null })
    })
  })

  it('refreshes the account catalog and disables the control while it runs', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const remote = remoteFor(async () => state({ accounts: [accountWith([modelView()])], activeAccountId: accountId }))
    vi.mocked(remote.refreshModels).mockImplementation(async () => {
      await gate
      return success(state({ accounts: [accountWith([modelView()])], activeAccountId: accountId }))
    })
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.refreshModels }))
    expect(await screen.findByRole('button', { name: en.refreshing })).toBeDefined()
    release()
    await waitFor(() => { expect(remote.refreshModels).toHaveBeenCalledWith({ accountId }) })
  })

  it('confirms sign-out and warns when the provider did not confirm revocation', async () => {
    const remote = remoteFor(async () => state({ accounts: [accountWith([])], activeAccountId: accountId }))
    vi.mocked(remote.signOut).mockResolvedValue(success({ revocationConfirmed: false }))
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.signOut }))
    const dialog = await screen.findByRole('dialog', { name: en.confirmSignOut })
    fireEvent.click(within(dialog).getByRole('button', { name: en.confirm }))
    await waitFor(() => { expect(remote.signOut).toHaveBeenCalledWith({ accountId }) })
    expect(await screen.findByText(en.signOutRevocationUnconfirmed)).toBeDefined()
  })

  it('dismisses the sign-out dialog without disconnecting', async () => {
    const remote = remoteFor(async () => state({ accounts: [accountWith([])], activeAccountId: accountId }))
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.signOut }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(remote.signOut).not.toHaveBeenCalled()
  })

  it('acknowledges the first-connection welcome and reports a failed acknowledgement', async () => {
    const first = remoteFor(async () => state({ accounts: [accountWith([])], welcomeAcknowledged: false }))
    const view = mount(first)
    expect(await screen.findByRole('dialog', { name: en.welcomeTitle })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.continue }))
    await waitFor(() => { expect(first.acknowledgeWelcome).toHaveBeenCalledOnce() })
    view.unmount()
    cleanup()

    const failing = remoteFor(async () => state({ accounts: [accountWith([])], welcomeAcknowledged: false }))
    vi.mocked(failing.acknowledgeWelcome).mockResolvedValue({
      ok: false,
      error: new RemoteError('gateway/internal', 'secret', {}),
    })
    mount(failing)
    await screen.findByRole('dialog', { name: en.welcomeTitle })
    fireEvent.click(screen.getByRole('button', { name: en.continue }))
    expect(await screen.findByText(en.actionFailed)).toBeDefined()
  })

  it('opens the preopened tab, then cancels tracked attempts when the page unloads', async () => {
    const replace = vi.fn()
    const close = vi.fn()
    const popup = { closed: false, opener: null, location: { replace }, close }
    vi.spyOn(window, 'open').mockReturnValue(popup as never)
    const remote = remoteFor(async () => state())
    const view = mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    await waitFor(() => { expect(replace).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize') })
    view.unmount()
    await waitFor(() => {
      expect(remote.cancelLogin).toHaveBeenCalledWith({ attemptId: brandString<ChatGptLoginAttemptId>('attempt-1') })
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  })

  it('cancels a pending attempt reported by the Host', async () => {
    const pending = { id: brandString<ChatGptLoginAttemptId>('attempt-9'), phase: 'awaiting-browser' as const }
    const remote = remoteFor(async () => state({
      accounts: [accountWith([])], activeAccountId: accountId, loginAttempts: [pending],
    }))
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.cancelLogin }))
    await waitFor(() => { expect(remote.cancelLogin).toHaveBeenCalledWith({ attemptId: pending.id }) })
  })

  it('polls the Host while a sign-in callback is pending', async () => {
    const pending = { id: brandString<ChatGptLoginAttemptId>('attempt-poll'), phase: 'awaiting-browser' as const }
    let calls = 0
    const remote = remoteFor(async () => {
      calls += 1
      return state({
        accounts: [accountWith([])],
        activeAccountId: accountId,
        loginAttempts: calls === 1 ? [pending] : [],
        loginPollIntervalMs: 1,
      })
    })
    mount(remote)
    await waitFor(() => { expect(calls).toBeGreaterThanOrEqual(2) })
  })

  it('reports a Host state failure without exposing Remote details', async () => {
    const remote = remoteFor(async () => state())
    vi.mocked(remote.getState).mockResolvedValue({
      ok: false,
      error: new RemoteError('gateway/internal', 'access_token=private', {}),
    })
    mount(remote)
    expect(await screen.findByText(en.actionFailed)).toBeDefined()
  })
})

describe('ChatGptSettingsSection interrupted and concurrent flows', () => {
  it('closes the welcome and sign-out dialogs without acknowledging or disconnecting', async () => {
    const welcome = remoteFor(async () => state({ accounts: [accountWith([])], welcomeAcknowledged: false }))
    mount(welcome)
    const welcomeDialog = await screen.findByRole('dialog', { name: en.welcomeTitle })
    fireEvent.click(within(welcomeDialog).getByRole('button', { name: en.close }))
    await waitFor(() => { expect(welcome.acknowledgeWelcome).toHaveBeenCalledOnce() })
    cleanup()

    const signOut = remoteFor(async () => state({ accounts: [accountWith([])], activeAccountId: accountId }))
    mount(signOut)
    fireEvent.click(await screen.findByRole('button', { name: en.signOut }))
    const signOutDialog = await screen.findByRole('dialog', { name: en.confirmSignOut })
    fireEvent.click(within(signOutDialog).getByRole('button', { name: en.close }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(signOut.signOut).not.toHaveBeenCalled()
  })

  it('closes the preopened tab and cancels the attempt when the view unloaded during sign-in', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const close = vi.fn()
    const popup = { closed: false, opener: null, location: { replace: vi.fn() }, close }
    vi.spyOn(window, 'open').mockReturnValue(popup as never)
    const remote = remoteFor(async () => state())
    vi.mocked(remote.beginLogin).mockImplementation(async () => {
      await gate
      return success({
        attemptId: brandString<ChatGptLoginAttemptId>('attempt-1'),
        authorizationUrl: 'https://auth.openai.com/oauth/authorize',
      })
    })
    const view = mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    view.unmount()
    expect(close).toHaveBeenCalled()
    release()
    await waitFor(() => {
      expect(remote.cancelLogin).toHaveBeenCalledWith({ attemptId: brandString<ChatGptLoginAttemptId>('attempt-1') })
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  })

  it('falls back to the visible link when the tab cannot navigate', async () => {
    const close = vi.fn()
    const popup = { closed: false, opener: null, location: { replace: () => { throw new Error('cross-origin') } }, close }
    vi.spyOn(window, 'open').mockReturnValue(popup as never)
    const pending = { id: brandString<ChatGptLoginAttemptId>('attempt-1'), phase: 'awaiting-browser' as const }
    const remote = remoteFor(async () => state({
      accounts: [accountWith([])],
      activeAccountId: accountId,
      loginAttempts: [pending],
    }))
    vi.mocked(remote.beginLogin).mockResolvedValue(success({
      attemptId: pending.id,
      authorizationUrl: 'https://auth.openai.com/oauth/authorize',
    }))
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    await waitFor(() => { expect(close).toHaveBeenCalled() })
    expect(await screen.findByRole('link', { name: en.openBrowser })).toBeDefined()
  })

  it('reports state polling failures and keeps the pending sign-in visible', async () => {
    const pending = { id: brandString<ChatGptLoginAttemptId>('attempt-poll'), phase: 'awaiting-browser' as const }
    let calls = 0
    const remote = remoteFor(async () => {
      calls += 1
      if (calls === 1) {
        return state({ accounts: [accountWith([])], activeAccountId: accountId, loginAttempts: [pending], loginPollIntervalMs: 1 })
      }
      throw new Error('offline')
    })
    const view = mount(remote)
    expect(await screen.findByText(en.actionFailed)).toBeDefined()
    expect(screen.getByRole('button', { name: en.cancelLogin })).toBeDefined()
    view.unmount()
  })

  it('ignores a second sign-out confirmation while the first is running', async () => {
    const remote = remoteFor(async () => state({ accounts: [accountWith([])], activeAccountId: accountId }))
    vi.mocked(remote.signOut).mockImplementation(async () => {
      await new Promise<void>(() => {})
      return success({ revocationConfirmed: true })
    })
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.signOut }))
    const dialog = await screen.findByRole('dialog', { name: en.confirmSignOut })
    const confirm = within(dialog).getByRole('button', { name: en.confirm })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(remote.signOut).toHaveBeenCalledTimes(1)
  })

  it('drops a save and a sign-out while another mutation owns the page', async () => {
    const remote = remoteFor(async () => state({
      accounts: [accountWith([modelView({ overridden: true, contextWindow: 1000 })])],
      activeAccountId: accountId,
    }))
    vi.mocked(remote.setModelConfig).mockImplementation(async () => {
      await new Promise<void>(() => {})
      return success(state())
    })
    mount(remote)
    fireEvent.click(await screen.findByText('Astra'))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    fireEvent.click(screen.getByRole('button', { name: en.resetModel }))
    expect(remote.setModelConfig).toHaveBeenCalledTimes(1)
  })
})

describe('ChatGptSettingsSection stale asynchronous results', () => {
  it('ignores a state snapshot that resolves after the page unloaded', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const remote = remoteFor(async () => {
      await gate
      return state({ accounts: [accountWith([])], activeAccountId: accountId })
    })
    const view = mount(remote)
    view.unmount()
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByRole('button', { name: en.signOut })).toBeNull()
  })

  it('keeps polling while an attempt stays pending and stops after unmount', async () => {
    const pending = { id: brandString<ChatGptLoginAttemptId>('attempt-poll'), phase: 'awaiting-browser' as const }
    let calls = 0
    const remote = remoteFor(async () => {
      calls += 1
      return state({
        accounts: [accountWith([])], activeAccountId: accountId,
        loginAttempts: [pending], loginPollIntervalMs: 1,
      })
    })
    const view = mount(remote)
    await waitFor(() => { expect(calls).toBeGreaterThanOrEqual(3) })
    view.unmount()
    const settled = calls
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls).toBe(settled)
  })

  it('drops the tracked ticket once the Host reports the attempt finished', async () => {
    let phase: 'awaiting-browser' | 'complete' = 'awaiting-browser'
    const attempt = { id: brandString<ChatGptLoginAttemptId>('attempt-1'), phase }
    const remote = remoteFor(async () => state({
      accounts: [accountWith([])],
      activeAccountId: accountId,
      loginAttempts: [{ ...attempt, phase }],
      loginPollIntervalMs: 1,
    }))
    vi.spyOn(window, 'open').mockReturnValue(null)
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    expect(await screen.findByRole('link', { name: en.openBrowser })).toBeDefined()
    phase = 'complete'
    await waitFor(() => { expect(screen.queryByRole('link', { name: en.openBrowser })).toBeNull() })
  })

  it('reports a state read failure after starting a sign-in', async () => {
    let calls = 0
    const remote = remoteFor(async () => {
      calls += 1
      if (calls === 1) return state()
      throw new Error('offline')
    })
    vi.spyOn(window, 'open').mockReturnValue(null)
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    expect(await screen.findByText(en.actionFailed)).toBeDefined()
  })

  it('closes the preopened tab when beginLogin fails', async () => {
    const close = vi.fn()
    const popup = { closed: false, opener: null, location: { replace: vi.fn() }, close }
    vi.spyOn(window, 'open').mockReturnValue(popup as never)
    const remote = remoteFor(async () => state())
    vi.mocked(remote.beginLogin).mockResolvedValue({
      ok: false,
      error: new RemoteError('gateway/internal', 'secret', {}),
    })
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    await waitFor(() => { expect(close).toHaveBeenCalled() })
    expect(await screen.findByText(en.actionFailed)).toBeDefined()
  })

  it('cancels a sign-in started after the page unloaded without a preopened tab', async () => {
    const attemptId = brandString<ChatGptLoginAttemptId>('attempt-1')
    let releaseLogin!: (value: Awaited<ReturnType<ChatGptRemote['beginLogin']>>) => void
    const loginGate = new Promise<Awaited<ReturnType<ChatGptRemote['beginLogin']>>>(resolve => { releaseLogin = resolve })
    const remote = remoteFor(async () => state())
    vi.mocked(remote.beginLogin).mockImplementation(async () => loginGate)
    vi.spyOn(window, 'open').mockReturnValue(null)
    const view = mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    await waitFor(() => { expect(remote.beginLogin).toHaveBeenCalledOnce() })

    view.unmount()
    releaseLogin(success({ attemptId, authorizationUrl: 'https://auth.openai.com/oauth/authorize' }))

    await waitFor(() => { expect(remote.cancelLogin).toHaveBeenCalledWith({ attemptId }) })
    expect(view.finishAttempt).not.toHaveBeenCalled()
  })

  it('ignores a sign-in start failure that lands after unmount', async () => {
    let rejectLogin!: (error: Error) => void
    const loginGate = new Promise<Awaited<ReturnType<ChatGptRemote['beginLogin']>>>((_resolve, reject) => { rejectLogin = reject })
    const remote = remoteFor(async () => state())
    vi.mocked(remote.beginLogin).mockImplementation(async () => loginGate)
    vi.spyOn(window, 'open').mockReturnValue(null)
    const view = mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    await waitFor(() => { expect(remote.beginLogin).toHaveBeenCalledOnce() })

    view.unmount()
    rejectLogin(new Error('offline'))
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a sign-in state read that fails after unmount', async () => {
    let calls = 0
    let rejectState!: (error: Error) => void
    const stateGate = new Promise<ChatGptState>((_resolve, reject) => { rejectState = reject })
    const remote = remoteFor(async () => {
      calls += 1
      return calls === 1 ? state() : stateGate
    })
    vi.spyOn(window, 'open').mockReturnValue(null)
    const view = mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    await waitFor(() => { expect(calls).toBeGreaterThanOrEqual(2) })

    view.unmount()
    rejectState(new Error('offline'))
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops a cancelled attempt that resolves after unmount', async () => {
    const pending = { id: brandString<ChatGptLoginAttemptId>('attempt-9'), phase: 'awaiting-browser' as const }
    let releaseCancel!: (value: Awaited<ReturnType<ChatGptRemote['cancelLogin']>>) => void
    const cancelGate = new Promise<Awaited<ReturnType<ChatGptRemote['cancelLogin']>>>(resolve => { releaseCancel = resolve })
    const remote = remoteFor(async () => state({
      accounts: [accountWith([])], activeAccountId: accountId, loginAttempts: [pending],
    }))
    vi.mocked(remote.cancelLogin).mockImplementation(async () => cancelGate)
    const view = mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.cancelLogin }))
    await waitFor(() => { expect(remote.cancelLogin).toHaveBeenCalledOnce() })

    view.unmount()
    releaseCancel(success(undefined))
    await act(async () => { await Promise.resolve() })

    expect(view.finishAttempt).not.toHaveBeenCalled()
  })

  it('ignores a save failure that lands after unmount', async () => {
    let rejectSave!: (error: Error) => void
    const saveGate = new Promise<Awaited<ReturnType<ChatGptRemote['setModelConfig']>>>((_resolve, reject) => { rejectSave = reject })
    const remote = remoteFor(async () => state({
      accounts: [accountWith([modelView({ overridden: true, contextWindow: 1000 })])],
      activeAccountId: accountId,
    }))
    vi.mocked(remote.setModelConfig).mockImplementation(async () => saveGate)
    const view = mount(remote)
    fireEvent.click(await screen.findByText('Astra'))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(remote.setModelConfig).toHaveBeenCalledOnce() })

    view.unmount()
    rejectSave(new Error('offline'))
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a Host state failure that lands after unmount', async () => {
    let rejectState!: (error: Error) => void
    const stateGate = new Promise<ChatGptState>((_resolve, reject) => { rejectState = reject })
    const remote = remoteFor(async () => stateGate)
    const view = mount(remote)

    view.unmount()
    rejectState(new Error('offline'))
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('ChatGptSettingsSection generation guards', () => {
  it('ignores a poll that resolves after unmount', async () => {
    const pending = { id: brandString<ChatGptLoginAttemptId>('attempt-gate'), phase: 'awaiting-browser' as const }
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const remote = remoteFor(async () => {
      calls += 1
      if (calls >= 2) await gate
      return state({
        accounts: [accountWith([])], activeAccountId: accountId,
        loginAttempts: [pending], loginPollIntervalMs: 1,
      })
    })
    const view = mount(remote)
    await waitFor(() => { expect(calls).toBeGreaterThanOrEqual(2) })
    view.unmount()
    release()
    await Promise.resolve()
  })

  it('drops a save that finishes after unmount', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const remote = remoteFor(async () => state({
      accounts: [accountWith([modelView({ overridden: true, contextWindow: 1000 })])],
      activeAccountId: accountId,
    }))
    vi.mocked(remote.setModelConfig).mockImplementation(async () => {
      await gate
      return success(state())
    })
    const view = mount(remote)
    fireEvent.click(await screen.findByText('Astra'))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.unmount()
    release()
    await Promise.resolve()
  })

  it('ignores a poll failure that lands after unmount', async () => {
    const pending = { id: brandString<ChatGptLoginAttemptId>('attempt-poll'), phase: 'awaiting-browser' as const }
    let calls = 0
    let rejectState!: (error: Error) => void
    const stateGate = new Promise<ChatGptState>((_resolve, reject) => { rejectState = reject })
    const remote = remoteFor(async () => {
      calls += 1
      return calls === 1
        ? state({ accounts: [accountWith([])], activeAccountId: accountId, loginAttempts: [pending], loginPollIntervalMs: 1 })
        : stateGate
    })
    const view = mount(remote)
    await waitFor(() => { expect(calls).toBeGreaterThanOrEqual(2) })

    view.unmount()
    rejectState(new Error('offline'))
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a refreshed catalog that lands after unmount', async () => {
    let releaseRefresh!: (value: Awaited<ReturnType<ChatGptRemote['refreshModels']>>) => void
    const refreshGate = new Promise<Awaited<ReturnType<ChatGptRemote['refreshModels']>>>(resolve => { releaseRefresh = resolve })
    const remote = remoteFor(async () => state({ accounts: [accountWith([modelView()])], activeAccountId: accountId }))
    vi.mocked(remote.refreshModels).mockImplementation(async () => refreshGate)
    const view = mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.refreshModels }))
    await waitFor(() => { expect(remote.refreshModels).toHaveBeenCalledOnce() })

    view.unmount()
    releaseRefresh(success(state({ accounts: [accountWith([modelView()])], activeAccountId: accountId })))
    await act(async () => { await Promise.resolve() })
  })
})

describe('ChatGptSettingsSection teardown settlement', () => {
  it('settles a tracked attempt after cancelling it on unload', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const pending = { id: brandString<ChatGptLoginAttemptId>('attempt-1'), phase: 'awaiting-browser' as const }
    const remote = remoteFor(async () => state({
      accounts: [accountWith([])], activeAccountId: accountId, loginAttempts: [pending],
    }))
    const view = mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    await screen.findByRole('button', { name: en.cancelLogin })
    view.unmount()
    await waitFor(() => {
      expect(view.finishAttempt).toHaveBeenCalledWith(brandString<ChatGptLoginAttemptId>('attempt-1'))
    })
  })

  it('keeps a tracked attempt when cancelling it during teardown fails', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const remote = remoteFor(async () => state())
    const view = mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    await waitFor(() => { expect(remote.beginLogin).toHaveBeenCalledOnce() })
    vi.mocked(remote.cancelLogin).mockResolvedValue({
      ok: false,
      error: new RemoteError('gateway/internal', 'secret', {}),
    })

    view.unmount()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(view.finishAttempt).not.toHaveBeenCalled()
  })
})
