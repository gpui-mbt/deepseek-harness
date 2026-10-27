/** ChatGPT account, plan, catalog, and per-model capability settings. */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChatGptAccountId, ChatGptAccountView, ChatGptLoginAttemptId, ChatGptModelConfig, ChatGptModelView, ChatGptState,
} from '@deepseek-ai/dsh-llm-chatgpt/types'
import type { ChatGptKey } from './locales.ts'
import css from './ChatGptSettingsSection.module.css'

/** The public Remote namespace used by the settings page. */
export type ChatGptRemote = Context['remote']['chatgpt']

/** Dependencies bound by the Client plugin to this root settings section. */
export interface ChatGptSettingsInjected {
  readonly remote: ChatGptRemote
  /** Track a locally created OAuth attempt until it reaches a terminal state. */
  readonly trackAttempt: (id: ChatGptLoginAttemptId) => void
  /** Stop tracking a cancelled or terminal OAuth attempt. */
  readonly finishAttempt: (id: ChatGptLoginAttemptId) => void
}

/** Props the Plugins page binds for the ChatGPT provider card. */
export type ChatGptSettingsProps = PropsRuntime<'plugins.item'>
  & PropsLocale<'chatgpt'>
  & InjectFace<ChatGptSettingsInjected>

type ErrorKey = 'actionFailed'

interface LoginTicketView {
  readonly attemptId: ChatGptLoginAttemptId
  readonly authorizationUrl: string
}

const USAGE_URL = 'https://chatgpt.com/settings/usage'

function loginPending(phase: ChatGptState['loginAttempts'][number]['phase']): boolean {
  return phase === 'awaiting-browser' || phase === 'exchanging'
}

function positiveInteger(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function statusKey(account: ChatGptAccountView): ChatGptKey {
  if (account.status === 'connected') return 'connected'
  if (account.status === 'needs-registration') return 'registrationRequired'
  return 'signInRequired'
}

function remoteValue<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error('ChatGPT Remote operation failed')
  return result.value
}

/** Try browser-owned popup cleanup without blocking Host authorization cancellation.
 * Opener-isolated provider tabs may reject parent-driven close after navigation.
 * @param popup - retained preopened window, if available.
 */
function closeLoginPopup(popup: Window | null | undefined): void {
  try { popup?.close() }
  catch { /* Browser policy owns the tab; the cancelled-state copy requests manual closure. */ }
}

/** Render the account and model configuration section.
 * @param props - localized settings and Remote operations.
 * @returns the account, login, and model settings view.
 */
export function ChatGptSettingsSection(props: ChatGptSettingsProps): ReactNode {
  const { view, remote, trackAttempt, finishAttempt, t } = props
  const [state, setState] = useState<ChatGptState | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ErrorKey | undefined>(undefined)
  const [modelSaved, setModelSaved] = useState(false)
  const [revocationWarning, setRevocationWarning] = useState(false)
  const [loginTickets, setLoginTickets] = useState<ReadonlyMap<ChatGptLoginAttemptId, LoginTicketView>>(() => new Map())
  const [signOutTarget, setSignOutTarget] = useState<ChatGptAccountView | undefined>(undefined)
  const [welcomeError, setWelcomeError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const requestGeneration = useRef(0)
  const live = useRef(false)
  const isLive = (): boolean => live.current
  const popupWindows = useRef(new Map<ChatGptLoginAttemptId, Window>())
  const pendingPopups = useRef(new Set<Window>())
  const pendingAttempts = useRef(new Set<ChatGptLoginAttemptId>())

  const applyState = useCallback((next: ChatGptState, generation?: number) => {
    if (!live.current || (generation !== undefined && requestGeneration.current !== generation)) return
    setState(next)
    for (const attempt of next.loginAttempts) {
      if (!loginPending(attempt.phase)) {
        finishAttempt(attempt.id)
        pendingAttempts.current.delete(attempt.id)
        closeLoginPopup(popupWindows.current.get(attempt.id))
        popupWindows.current.delete(attempt.id)
        setLoginTickets(current => {
          if (!current.has(attempt.id)) return current
          const updated = new Map(current)
          updated.delete(attempt.id)
          return updated
        })
      }
    }
  }, [finishAttempt])

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++requestGeneration.current
    try {
      applyState(remoteValue(await remote.getState()), generation)
      if (isLive() && requestGeneration.current === generation) setError(undefined)
    } catch (_error) {
      if (isLive() && requestGeneration.current === generation) setError('actionFailed')
    }
  }, [applyState, remote])

  useEffect(() => {
    live.current = true
    void refresh()
    return () => {
      live.current = false
      requestGeneration.current += 1
      for (const popup of pendingPopups.current) closeLoginPopup(popup)
      for (const popup of popupWindows.current.values()) closeLoginPopup(popup)
      pendingPopups.current.clear()
      popupWindows.current.clear()
      for (const attemptId of pendingAttempts.current) {
        void remote.cancelLogin({ attemptId }).then(remoteValue).then(() => {
          finishAttempt(attemptId)
        }).catch(() => {
          // Plugin teardown retries attempts that remain tracked.
        })
      }
      pendingAttempts.current.clear()
    }
  }, [finishAttempt, refresh, remote])

  const pendingLogin = loginTickets.size > 0
    || (state?.loginAttempts.some(attempt => loginPending(attempt.phase)) ?? false)
  const pollInterval = state?.loginPollIntervalMs
  useEffect(() => {
    if (!pendingLogin || pollInterval === undefined || busy) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const generation = ++requestGeneration.current
      try {
        const next = remoteValue(await remote.getState())
        if (!active || !live.current || requestGeneration.current !== generation) return
        applyState(next, generation)
        setError(undefined)
        if (loginTickets.size > 0 || next.loginAttempts.some(attempt => loginPending(attempt.phase))) {
          timer = setTimeout(() => { void poll() }, next.loginPollIntervalMs)
        }
      } catch (_error) {
        if (active && live.current && requestGeneration.current === generation) {
          setError('actionFailed')
          timer = setTimeout(() => { void poll() }, pollInterval)
        }
      }
    }
    timer = setTimeout(() => { void poll() }, pollInterval)
    return () => {
      active = false
      /* v8 ignore next -- the effect schedules its poll timer before registering this cleanup, and timer is never reset to undefined. */
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [applyState, busy, loginTickets, pendingLogin, pollInterval, remote])

  const mutate = useCallback(async <T,>(
    action: () => Promise<T>,
    stateFromResult?: (result: T) => ChatGptState | undefined,
  ): Promise<T | undefined> => {
    /* v8 ignore next -- every caller is a disabled-while-busy control. */
    if (busy) return undefined
    setBusy(true)
    setError(undefined)
    setModelSaved(false)
    setRevocationWarning(false)
    const generation = ++requestGeneration.current
    try {
      const result = await action()
      if (!live.current || requestGeneration.current !== generation) return undefined
      if (stateFromResult !== undefined) {
        const next = stateFromResult(result)
        /* v8 ignore next -- every stateFromResult caller returns a ChatGptState; RemoteResult typing excludes undefined. */
        if (next !== undefined) applyState(next, generation)
      }
      return result
    } catch (_error) {
      if (isLive() && requestGeneration.current === generation) setError('actionFailed')
      return undefined
    } finally {
      if (isLive() && requestGeneration.current === generation) setBusy(false)
    }
  }, [applyState, busy])

  const beginLogin = async (accountId?: ChatGptAccountId): Promise<void> => {
    /* v8 ignore next -- the sign-in control is disabled while busy. */
    if (busy) return
    setBusy(true)
    setError(undefined)
    setModelSaved(false)
    let popup: Window | null = null
    try { popup = window.open('about:blank', '_blank') }
    catch (_error) { /* The authorization link remains available when popups are blocked. */ }
    if (popup !== null) {
      popup.opener = null
      pendingPopups.current.add(popup)
    }
    const generation = ++requestGeneration.current
    let ticket: import('@deepseek-ai/dsh-llm-chatgpt/types').ChatGptLoginTicket
    try {
      ticket = remoteValue(await remote.beginLogin(accountId === undefined ? {} : { accountId }))
      if (!live.current || requestGeneration.current !== generation) {
        try { remoteValue(await remote.cancelLogin({ attemptId: ticket.attemptId })) }
        catch (_error) { /* The attempt may have completed while the view was closing. */ }
        closeLoginPopup(popup)
        if (popup !== null) pendingPopups.current.delete(popup)
        /* v8 ignore next -- the stale branch above implies this generation check fails. */
        if (isLive() && requestGeneration.current === generation) setBusy(false)
        return
      }
    } catch (_error) {
      closeLoginPopup(popup)
      if (popup !== null) pendingPopups.current.delete(popup)
      if (live.current && requestGeneration.current === generation) {
        setError('actionFailed')
        setBusy(false)
      }
      return
    }
    trackAttempt(ticket.attemptId)
    pendingAttempts.current.add(ticket.attemptId)
    setLoginTickets(current => new Map(current).set(ticket.attemptId, ticket))
    if (popup !== null && !popup.closed) {
      pendingPopups.current.delete(popup)
      popupWindows.current.set(ticket.attemptId, popup)
      try { popup.location.replace(ticket.authorizationUrl) }
      catch (_error) { closeLoginPopup(popup); popupWindows.current.delete(ticket.attemptId) }
    } else {
      try { window.open(ticket.authorizationUrl, '_blank', 'noopener,noreferrer') }
      catch (_error) { /* The visible link below remains available. */ }
    }
    try {
      applyState(remoteValue(await remote.getState()), generation)
    } catch (_error) {
      if (isLive() && requestGeneration.current === generation) setError('actionFailed')
    } finally {
      if (isLive() && requestGeneration.current === generation) setBusy(false)
    }
  }

  const cancelLogin = async (attemptId: ChatGptLoginAttemptId): Promise<void> => {
    /* v8 ignore next -- the cancel control is disabled while busy. */
    if (busy) return
    const popup = popupWindows.current.get(attemptId)
    closeLoginPopup(popup)
    popupWindows.current.delete(attemptId)
    const result = await mutate(async () => {
      remoteValue(await remote.cancelLogin({ attemptId }))
      return remoteValue(await remote.getState())
    }, value => value)
    if (result !== undefined) {
      finishAttempt(attemptId)
      pendingAttempts.current.delete(attemptId)
      setLoginTickets(current => {
        const updated = new Map(current)
        updated.delete(attemptId)
        return updated
      })
      applyState(result)
    }
  }

  const changeActiveAccount = async (accountId: ChatGptAccountId): Promise<void> => {
    await mutate(async () => {
      remoteValue(await remote.setActiveAccount({ accountId }))
      return remoteValue(await remote.getState())
    }, value => value)
  }

  const refreshModels = async (accountId: ChatGptAccountId): Promise<void> => {
    setRefreshing(true)
    try {
      const result = await mutate(async () => remoteValue(await remote.refreshModels({ accountId })), value => value)
      if (result !== undefined && live.current) setState(result)
    } finally {
      if (live.current) setRefreshing(false)
    }
  }

  const saveModelConfig = async (
    accountId: ChatGptAccountId,
    model: string,
    config: ChatGptModelConfig | null,
  ): Promise<boolean> => {
    const result = await mutate(async () => remoteValue(await remote.setModelConfig({ accountId, model, config })), value => value)
    if (result === undefined) return false
    setState(result)
    setModelSaved(true)
    return true
  }

  const signOut = async (account: ChatGptAccountView): Promise<void> => {
    const result = await mutate(() => remote.signOut({ accountId: account.id }).then(remoteValue))
    /* v8 ignore next -- the confirmation control is disabled while a mutation owns the page. */
    if (result === undefined) return
    setSignOutTarget(undefined)
    await refresh()
    if (!result.revocationConfirmed) setRevocationWarning(true)
  }

  const acknowledgeWelcome = async (): Promise<void> => {
    setWelcomeError(false)
    const completed = await mutate(async () => {
      remoteValue(await remote.acknowledgeWelcome())
      return remoteValue(await remote.getState())
    }, value => value)
    if (completed === undefined) {
      setWelcomeError(true)
      return
    }
    applyState(completed)
  }

  const activeAccount = useMemo(
    () => state?.accounts.find(account => account.id === state.activeAccountId),
    [state],
  )
  const showWelcome = state !== undefined && !state.welcomeAcknowledged
    && state.accounts.some(account => account.status === 'connected')

  if (view === 'summary') return t('summary')

  if (state === undefined) {
    return <div className={css.section}>
      {error === undefined ? <p role="status">{t('loading')}</p> : <p className={css.error} role="alert">{t(error)}</p>}
    </div>
  }

  return (
    <div className={css.section}>
      <header className={css.header}>
        <p className={css.intro}>{t('intro')}</p>
      </header>

      {error !== undefined && <p className={css.error} role="alert">{t(error)}</p>}
      {modelSaved && <p className={css.success} role="status">{t('modelSaved')}</p>}
      {revocationWarning && <p className={css.warning} role="status">{t('signOutRevocationUnconfirmed')}</p>}

      <section className={css.card} aria-labelledby="chatgpt-accounts-title">
        <div className={css.cardHeader}>
          <h3 id="chatgpt-accounts-title">{t('accounts')}</h3>
          <Button variant="primary" disabled={busy}
            onClick={() => { void beginLogin() }}>{t('continueWithChatGPT')}</Button>
        </div>

        {state.accounts.length === 0
          ? <p className={css.empty}>{t('noAccounts')}</p>
          : <ul className={css.accountList}>
            {state.accounts.map(account => (
              <li className={css.account} key={account.id}>
                <div className={css.accountInfo}>
                  <strong className={css.accountLabel}>{account.label}</strong>
                  {account.email !== undefined && <span className={css.secondary}>{account.email}</span>}
                  <span className={account.status === 'connected' ? css.statusReady : css.statusNeedsAction}>
                    {t(statusKey(account))}
                  </span>
                </div>
                <div className={css.accountActions}>
                  {account.status !== 'connected' && <Button variant="primary" disabled={busy}
                    onClick={() => { void beginLogin(account.id) }}>{t('continueWithChatGPT')}</Button>}
                  <Button variant="ghost" size="sm" disabled={busy}
                    onClick={() => { setSignOutTarget(account) }}>{t('signOut')}</Button>
                </div>
              </li>
            ))}
          </ul>}

        <label className={css.activeSelect}>
          <span>{t('activeAccount')}</span>
          <select
            value={state.activeAccountId ?? ''}
            disabled={busy || !state.accounts.some(account => account.status === 'connected')}
            onChange={event => {
              const account = state.accounts.find(row => row.id === event.currentTarget.value)
              if (account?.status === 'connected') void changeActiveAccount(account.id)
            }}
          >
            <option value="" disabled>{t('noActiveAccount')}</option>
            {state.accounts.map(account => <option key={account.id} value={account.id} disabled={account.status !== 'connected'}>
              {account.label}{account.email === undefined ? '' : ` · ${account.email}`}
            </option>)}
          </select>
        </label>
      </section>

      {state.loginAttempts.map(attempt => {
        const ticket = loginTickets.get(attempt.id)
        const label = attempt.phase === 'awaiting-browser' ? t('loginWaiting')
          : attempt.phase === 'exchanging' ? t('loginExchanging')
            : attempt.phase === 'complete' ? t('loginComplete')
              : attempt.phase === 'cancelled' ? t('loginCancelled') : t('loginFailed')
        return <div
          className={attempt.phase === 'failed' ? css.error : css.loginStatus}
          key={attempt.id}
          role={attempt.phase === 'failed' ? 'alert' : 'status'}
        >
          <span>{label}</span>
          {attempt.message !== undefined && <span>{attempt.message}</span>}
          {ticket !== undefined && loginPending(attempt.phase) && <a href={ticket.authorizationUrl}
            className={css.inlineLink} target="_blank" rel="noopener noreferrer">{t('openBrowser')}</a>}
          {loginPending(attempt.phase) && <Button variant="ghost" size="sm" disabled={busy}
            onClick={() => { void cancelLogin(attempt.id) }}>{t('cancelLogin')}</Button>}
        </div>
      })}

      {activeAccount !== undefined && <section className={css.card} aria-labelledby="chatgpt-models-title">
        <div className={css.cardHeader}>
          <h3 id="chatgpt-models-title">{t('accountModels')}</h3>
          <Button variant="outline" size="sm" disabled={busy || refreshing}
            onClick={() => { void refreshModels(activeAccount.id) }}>{t(refreshing ? 'refreshing' : 'refreshModels')}</Button>
        </div>
        {activeAccount.models.length === 0
          ? <p className={css.empty}>{t('modelsEmpty')}</p>
          : <div className={css.modelList}>
            {activeAccount.models.map(model => <ModelConfigEditor key={`${activeAccount.id}:${model.slug}`}
              accountId={activeAccount.id} model={model} busy={busy} save={saveModelConfig} t={t} />)}
          </div>}
      </section>}

      {activeAccount?.status === 'connected' && <div className={css.planInfo}>
        <p>{t('usingPlan')}</p>
        <a className={css.manageLink} href={USAGE_URL} target="_blank" rel="noopener noreferrer">{t('manageUsage')}</a>
      </div>}

      {showWelcome && <Modal open title={t('welcomeTitle')} closeLabel={t('close')}
        description={t('welcomeDescription')} onClose={() => { void acknowledgeWelcome() }}
        footer={<Button variant="primary" onClick={() => { void acknowledgeWelcome() }}>{t('continue')}</Button>}>
        {welcomeError && <p className={css.error} role="alert">{t('actionFailed')}</p>}
        <a className={css.inlineLink} href={USAGE_URL} target="_blank" rel="noopener noreferrer">{t('manageUsage')}</a>
      </Modal>}

      {signOutTarget !== undefined && <Modal open title={t('confirmSignOut')} closeLabel={t('close')}
        description={t('confirmSignOutDescription')} onClose={() => { setSignOutTarget(undefined) }}
        footer={<>
          <Button variant="outline" disabled={busy} onClick={() => { setSignOutTarget(undefined) }}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy}
            onClick={() => { void signOut(signOutTarget) }}>{t(busy ? 'saving' : 'confirm')}</Button>
        </>} />}
    </div>
  )
}

interface ModelConfigEditorProps {
  readonly accountId: ChatGptAccountId
  readonly model: ChatGptModelView
  readonly busy: boolean
  readonly save: (accountId: ChatGptAccountId, model: string, config: ChatGptModelConfig | null) => Promise<boolean>
  readonly t: ChatGptSettingsProps['t']
}

function ModelConfigEditor({ accountId, model, busy, save, t }: ModelConfigEditorProps): ReactNode {
  const id = useId()
  const [contextWindow, setContextWindow] = useState(model.contextWindow?.toString() ?? '')
  const [modalities, setModalities] = useState<readonly ModelModality[]>(model.inputModalities ?? ['text'])
  const [reasoning, setReasoning] = useState(model.reasoningEfforts?.join(', ') ?? '')
  const [defaultReasoning, setDefaultReasoning] = useState(model.defaultReasoningEffort ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setContextWindow(model.contextWindow?.toString() ?? '')
    setModalities(model.inputModalities ?? ['text'])
    setReasoning(model.reasoningEfforts?.join(', ') ?? '')
    setDefaultReasoning(model.defaultReasoningEffort ?? '')
  }, [model.slug, model.contextWindow, model.inputModalities?.join(','), model.reasoningEfforts?.join(','), model.defaultReasoningEffort])

  const parsedReasoning = reasoning.split(',').map(value => value.trim()).filter(value => value !== '')
  const parsedContext = positiveInteger(contextWindow)
  const normalizedDefault = defaultReasoning.trim()
  const validDefaultReasoning = normalizedDefault === '' || parsedReasoning.includes(normalizedDefault)
  const canSave = !busy && !saving && parsedContext !== undefined && validDefaultReasoning && modalities.length > 0
  const updateModality = (modality: ModelModality, checked: boolean): void => {
    setModalities(current => checked
      ? current.includes(modality)
        /* v8 ignore start -- React reports a checkbox change only after the checked state flips, so a modality is never reported checked while already included. */
        ? current
        : [...current, modality]
        /* v8 ignore stop */
      : current.filter(value => value !== modality))
  }
  const commit = async (config: ChatGptModelConfig | null): Promise<void> => {
    setSaving(true)
    try { await save(accountId, model.slug, config) }
    finally { setSaving(false) }
  }
  return <details className={css.model}>
    <summary className={css.modelSummary}>
      <span className={css.modelIdentity}><strong>{model.displayName}</strong><code>{model.slug}</code></span>
      <span className={model.usable ? css.statusReady : css.statusNeedsAction}>{t(model.usable ? 'modelReady' : 'modelNeedsContext')}</span>
    </summary>
    <div className={css.modelBody}>
      <h4>{t('modelSettings')}</h4>
      <div className={css.field}>
        <label htmlFor={`${id}-context`}>{t('contextWindow')}</label>
        <input id={`${id}-context`} type="number" min="1" step="1" inputMode="numeric" value={contextWindow}
          aria-invalid={parsedContext === undefined}
          aria-describedby={parsedContext === undefined ? `${id}-context-error` : undefined}
          onChange={event => { setContextWindow(event.currentTarget.value) }} />
        {parsedContext === undefined && <span className={css.validation} id={`${id}-context-error`}>{t('contextWindowRequired')}</span>}
      </div>
      <fieldset className={css.fieldset} aria-invalid={modalities.length === 0}
        aria-describedby={modalities.length === 0 ? `${id}-input-error` : undefined}>
        <legend>{t('inputModalities')}</legend>
        <label className={css.checkbox}><input type="checkbox" checked={modalities.includes('text')}
          onChange={event => { updateModality('text', event.currentTarget.checked) }} /><span>{t('textInput')}</span></label>
        <label className={css.checkbox}><input type="checkbox" checked={modalities.includes('image')}
          onChange={event => { updateModality('image', event.currentTarget.checked) }} /><span>{t('imageInput')}</span></label>
        {modalities.length === 0 && <span className={css.validation} id={`${id}-input-error`}>{t('inputTypeRequired')}</span>}
      </fieldset>
      <label className={css.field}>
        <span>{t('reasoningEfforts')}</span>
        <input type="text" value={reasoning} placeholder={t('reasoningPlaceholder')}
          onChange={event => { setReasoning(event.currentTarget.value) }} />
      </label>
      <div className={css.field}>
        <label htmlFor={`${id}-default-reasoning`}>{t('defaultReasoningEffort')}</label>
        <input id={`${id}-default-reasoning`} type="text" value={defaultReasoning} placeholder={model.defaultReasoningEffort ?? ''}
          aria-invalid={!validDefaultReasoning}
          aria-describedby={!validDefaultReasoning ? `${id}-reasoning-error` : undefined}
          onChange={event => { setDefaultReasoning(event.currentTarget.value) }} />
        {!validDefaultReasoning && <span className={css.validation} id={`${id}-reasoning-error`}>{t('reasoningDefaultUnavailable')}</span>}
      </div>
      <div className={css.modelActions}>
        <Button variant="primary" size="sm" disabled={!canSave || modalities.length === 0}
          onClick={() => { void commit({
            /* v8 ignore next -- the save control is disabled unless parsedContext is defined. */
            ...(parsedContext === undefined ? {} : { contextWindow: parsedContext }),
            /* v8 ignore next -- the save control is disabled unless at least one modality is selected. */
            ...(modalities.length === 0 ? {} : { inputModalities: modalities }),
            ...(parsedReasoning.length === 0 ? {} : { reasoningEfforts: parsedReasoning }),
            ...(defaultReasoning.trim() === '' ? {} : { defaultReasoningEffort: defaultReasoning.trim() }),
          }) }}>{t(saving ? 'saving' : 'save')}</Button>
        {model.overridden && <Button variant="outline" size="sm" disabled={busy || saving}
          onClick={() => { void commit(null) }}>{t('resetModel')}</Button>}
      </div>
    </div>
  </details>
}
