/**
 * Dots page: the dot list with live status, creation defaults, and the
 * selected dot's assignment, memory, tool allowlist, schedule, and archive
 * actions. Every Host call goes through the injected `dots` Remote face and
 * every failure renders its own localized sentence, never a Remote message.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { DotId, DotStatus, DotView, ScheduleRecordLike } from '@deepseek-ai/dsh-dots/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { DotsKey } from './locales.ts'
import css from './DotsPanel.module.css'

/** Remote namespace face and Session navigation bound by the Client plugin. */
export interface DotsPanelInjected {
  /** The `dots` Remote namespace: listing, mutations, and schedules. */
  readonly remote: ClientRemote['dots']
  /**
   * Reveal one dot's home Session in the main column. The Session Controller
   * retains and loads the Session, so a cold dot opens the same way a listed
   * Session does.
   * @param sessionId - home Session identity taken from the dot view.
   */
  readonly openSession: (sessionId: string) => void
}

/** Root-scoped Dots page props derived from the framework and injected face. */
export type DotsPanelProps = PropsRuntime<'main'> & PropsLocale<'dots'> & InjectFace<DotsPanelInjected>

/** One localized sentence with its optional template values. */
interface Sentence {
  readonly key: DotsKey
  readonly params?: Readonly<Record<string, string | number>>
}

/** Per-dot schedule state: a load in flight, a settled list, or a failed read. */
type ScheduleState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'failed' }
  | { readonly phase: 'ready'; readonly records: readonly ScheduleRecordLike[] }

/** Values captured by the creation form. */
interface CreateForm {
  readonly name: string
  readonly purpose: string
  readonly preset: string
  readonly permission: string
  readonly tools: string
}

const EMPTY_FORM: CreateForm = { name: '', purpose: '', preset: '', permission: '', tools: '' }

const STATUS_TONE: Readonly<Record<DotStatus, TagTone>> = {
  running: 'success',
  idle: 'info',
  asleep: 'neutral',
  missing: 'danger',
}

const STATUS_KEY: Readonly<Record<DotStatus, DotsKey>> = {
  running: 'status.running',
  idle: 'status.idle',
  asleep: 'status.asleep',
  missing: 'status.missing',
}

const INSTANT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Unwind one operation after its localized failure was published. `perform`
 * recognizes it so the Remote result's own details never reach the page.
 */
class DotsRequestFailed extends Error {}

/**
 * Split a comma or newline separated tool list.
 * @param value - raw field text.
 * @returns trimmed, non-empty patterns.
 */
function toolList(value: string): string[] {
  return value
    .split(/[\n,]+/u)
    .map(item => item.trim())
    .filter(item => item.length > 0)
}

/**
 * Format one millisecond instant in the browser's locale.
 * @param value - milliseconds since the Unix epoch.
 * @returns the localized date and time.
 */
function instant(value: number): string {
  return INSTANT.format(value)
}

/**
 * Render the Dots page.
 * @param props - the `dots` Remote face, Session navigation, and localized copy seat.
 * @returns the page.
 */
export function DotsPanel({ remote, openSession, t }: DotsPanelProps): ReactNode {
  const [dots, setDots] = useState<readonly DotView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<DotId | null>(null)
  const [schedules, setSchedules] = useState<ScheduleState>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Sentence | null>(null)
  const [error, setError] = useState<Sentence | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM)
  const [assignText, setAssignText] = useState('')
  const [memoryText, setMemoryText] = useState('')
  const [toolsDraft, setToolsDraft] = useState<{ readonly dot: DotId; readonly text: string } | null>(null)
  const [scheduleTitle, setScheduleTitle] = useState('')
  const [schedulePrompt, setSchedulePrompt] = useState('')
  const [scheduleDelay, setScheduleDelay] = useState('60')
  const [confirming, setConfirming] = useState<DotView | null>(null)

  useEffect(() => {
    let active = true
    void remote.list({}).then(result => {
      if (!active) return
      setLoaded(true)
      if (result.ok) setDots(result.value.dots)
      else setError({ key: 'error.load' })
    })
    return () => {
      active = false
    }
  }, [remote])

  const selected = dots.find(dot => dot.id === selectedId) ?? dots[0]
  const selectedKey = selected?.id

  useEffect(() => {
    if (selectedKey === undefined) {
      setSchedules({ phase: 'ready', records: [] })
      return
    }
    let active = true
    setSchedules({ phase: 'loading' })
    void remote.scheduleList({ dot: selectedKey }).then(result => {
      if (!active) return
      if (result.ok) setSchedules({ phase: 'ready', records: result.value.schedules })
      else {
        setSchedules({ phase: 'failed' })
        setError({ key: 'error.scheduleList' })
      }
    })
    return () => {
      active = false
    }
  }, [remote, selectedKey])

  const perform = async (key: DotsKey, operation: () => Promise<Sentence | undefined>): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = await operation()
      if (next !== undefined) setNotice(next)
    } catch (caught) {
      // A RemoteResult already published its own sentence; anything else is an
      // assembly fault whose message must not reach the page.
      if (!(caught instanceof DotsRequestFailed)) setError({ key })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Await one Remote call and publish its localized failure sentence.
   * @param call - Remote invocation returning the generated result envelope.
   * @param key - failure sentence for this operation.
   * @returns the business value; throws {@link DotsRequestFailed} on failure.
   */
  const attempt = async <T,>(call: () => Promise<RemoteResult<T>>, key: DotsKey): Promise<T> => {
    const result = await call()
    if (!result.ok) {
      setError({ key })
      throw new DotsRequestFailed()
    }
    return result.value
  }

  const load = async (): Promise<void> => {
    const result = await remote.list({})
    setLoaded(true)
    if (result.ok) setDots(result.value.dots)
    else setError({ key: 'error.load' })
  }

  const refresh = async (): Promise<void> => {
    await perform('error.load', async () => {
      await load()
      return undefined
    })
  }

  const select = (id: DotId): void => {
    setSelectedId(id)
    setAssignText('')
    setMemoryText('')
    setToolsDraft(null)
    setNotice(null)
    setError(null)
  }

  const create = async (): Promise<void> => {
    const name = form.name.trim()
    const purpose = form.purpose.trim()
    const preset = form.preset.trim()
    const permission = form.permission.trim()
    const tools = toolList(form.tools)
    await perform('error.create', async () => {
      const created = await attempt(
        () =>
          remote.create({
            name,
            purpose,
            ...(preset === '' ? {} : { preset }),
            ...(permission === '' ? {} : { permissionPreset: permission }),
            ...(tools.length === 0 ? {} : { allowedTools: tools }),
          }),
        'error.create',
      )
      setForm(EMPTY_FORM)
      setCreating(false)
      setSelectedId(created.view.id)
      setDots(current => [...current, created.view])
      return created.warnings.length === 0
        ? { key: 'notice.created', params: { name: created.view.name } }
        : { key: 'notice.createdWithWarnings', params: { name: created.view.name, warnings: created.warnings.join('; ') } }
    })
  }

  const assign = async (dot: DotView): Promise<void> => {
    const task = assignText.trim()
    await perform('error.assign', async () => {
      await attempt(() => remote.assign({ dot: dot.id, task }), 'error.assign')
      setAssignText('')
      await load()
      return { key: 'notice.assignmentQueued' }
    })
  }

  const remember = async (dot: DotView): Promise<void> => {
    const note = memoryText.trim()
    await perform('error.memory', async () => {
      await attempt(() => remote.update({ dot: dot.id, addMemory: note }), 'error.memory')
      setMemoryText('')
      await load()
      return { key: 'notice.memoryAppended' }
    })
  }

  const saveTools = async (dot: DotView, value: string): Promise<void> => {
    const tools = toolList(value)
    if (tools.length === 0) {
      setError({ key: 'error.toolsRequired' })
      return
    }
    await perform('error.tools', async () => {
      await attempt(() => remote.update({ dot: dot.id, allowedTools: tools }), 'error.tools')
      setToolsDraft(null)
      await load()
      return { key: 'notice.toolsSaved' }
    })
  }

  const createSchedule = async (dot: DotView): Promise<void> => {
    const title = scheduleTitle.trim()
    const prompt = schedulePrompt.trim()
    if (title === '' || prompt === '') {
      setError({ key: 'error.scheduleRequired' })
      return
    }
    const seconds = Number(scheduleDelay)
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      setError({ key: 'error.delay' })
      return
    }
    await perform('error.schedule', async () => {
      const created = await attempt(
        () => remote.scheduleCreate({ dot: dot.id, title, prompt, after_seconds: seconds }),
        'error.schedule',
      )
      setScheduleTitle('')
      setSchedulePrompt('')
      setSchedules(current =>
        current.phase === 'ready'
          ? { phase: 'ready', records: [...current.records, created] }
          : { phase: 'ready', records: [created] },
      )
      return { key: 'notice.scheduleCreated' }
    })
  }

  const archive = async (dot: DotView): Promise<void> => {
    await perform('error.archive', async () => {
      await attempt(() => remote.archive({ dot: dot.id, stopSchedules: true }), 'error.archive')
      setConfirming(null)
      setSelectedId(null)
      setDots(current => current.filter(item => item.id !== dot.id))
      return { key: 'notice.archived', params: { name: dot.name } }
    })
  }

  const toolsValue =
    toolsDraft !== null && toolsDraft.dot === selected?.id
      ? toolsDraft.text
      : (selected?.allowedTools?.join(', ') ?? '')

  return (
    <section className={css.page} aria-label={t('title')} data-testid="dots-panel">
      <header className={css.header}>
        <div className={css.heading}>
          <h1 className={css.title}>{t('title')}</h1>
          <p className={css.subtitle}>{t('subtitle')}</p>
        </div>
        <div className={css.row}>
          <Button variant="outline" size="sm" disabled={busy || !loaded} onClick={() => { void refresh() }}>
            {t('refresh')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !loaded}
            onClick={() => { setCreating(value => !value) }}
          >
            {creating ? t('close') : t('new')}
          </Button>
        </div>
      </header>

      {error !== null && (
        <p className={css.error} role="alert">{t(error.key, error.params)}</p>
      )}
      {notice !== null && (
        <p className={css.notice} role="status">{t(notice.key, notice.params)}</p>
      )}

      {creating && (
        <form
          className={css.form}
          onSubmit={event => {
            event.preventDefault()
            void create()
          }}
        >
          <h2 className={css.sectionTitle}>{t('create.title')}</h2>
          <div className={css.formGrid}>
            <Field label={t('create.name')}>
              <input
                className={css.input}
                value={form.name}
                onChange={event => { setForm({ ...form, name: event.target.value }) }}
                placeholder={t('create.namePlaceholder')}
                required
              />
            </Field>
            <Field label={t('create.preset')}>
              <input
                className={css.input}
                value={form.preset}
                onChange={event => { setForm({ ...form, preset: event.target.value }) }}
                placeholder={t('create.presetPlaceholder')}
              />
            </Field>
          </div>
          <Field label={t('create.purpose')}>
            <textarea
              className={css.textarea}
              value={form.purpose}
              onChange={event => { setForm({ ...form, purpose: event.target.value }) }}
              placeholder={t('create.purposePlaceholder')}
              required
            />
          </Field>
          <div className={css.formGrid}>
            <Field label={t('create.permission')}>
              <input
                className={css.input}
                value={form.permission}
                onChange={event => { setForm({ ...form, permission: event.target.value }) }}
                placeholder={t('create.permissionPlaceholder')}
              />
            </Field>
            <Field label={t('create.tools')}>
              <input
                className={css.input}
                value={form.tools}
                onChange={event => { setForm({ ...form, tools: event.target.value }) }}
                placeholder={t('create.toolsPlaceholder')}
              />
            </Field>
          </div>
          <div className={css.row}>
            <Button variant="primary" size="sm" type="submit" disabled={busy}>
              {t('create.create')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { setCreating(false) }}>
              {t('create.cancel')}
            </Button>
          </div>
        </form>
      )}

      {!loaded && <p className={css.empty}>{t('loading')}</p>}
      {loaded && dots.length === 0 && error === null && <p className={css.empty}>{t('empty')}</p>}

      {loaded && dots.length > 0 && (
        <div className={css.body}>
          <ul className={css.list}>
            {dots.map(dot => (
              <li key={dot.id}>
                <button
                  type="button"
                  className={css.item}
                  aria-pressed={dot.id === selected?.id}
                  onClick={() => { select(dot.id) }}
                >
                  <span className={css.itemHead}>
                    <span className={css.name}>{dot.name}</span>
                    <Tag tone={STATUS_TONE[dot.status]}>{t(STATUS_KEY[dot.status])}</Tag>
                  </span>
                  <span className={css.purpose}>{dot.purpose}</span>
                  <span className={css.meta}>
                    <span>
                      {t(
                        dot.assignmentCount === 1 ? 'card.assignments.one' : 'card.assignments.other',
                        { count: dot.assignmentCount },
                      )}
                    </span>
                    <span>
                      {dot.lastAssignedAt === undefined
                        ? t('card.never')
                        : t('card.lastAssigned', { time: instant(dot.lastAssignedAt) })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {selected !== undefined && (
            <section className={css.detail} aria-label={t('detail.label')}>
              <header className={css.detailHead}>
                <div className={css.detailIdentity}>
                  <h2 className={css.detailTitle}>{selected.name}</h2>
                  <Tag tone={STATUS_TONE[selected.status]}>{t(STATUS_KEY[selected.status])}</Tag>
                </div>
                <div className={css.row}>
                  <Button variant="outline" size="sm" onClick={() => { openSession(selected.sessionId) }}>
                    {t('detail.openSession')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={css.danger}
                    disabled={busy}
                    onClick={() => { setConfirming(selected) }}
                  >
                    {t('detail.archive')}
                  </Button>
                </div>
              </header>

              <p className={css.detailPurpose}>{selected.purpose}</p>

              <dl className={css.kv}>
                <dt>{t('detail.session')}</dt>
                <dd>{selected.sessionId}</dd>
                {selected.workspaceId !== undefined && (
                  <>
                    <dt>{t('detail.workspace')}</dt>
                    <dd>{selected.workspaceId}</dd>
                  </>
                )}
                <dt>{t('detail.directory')}</dt>
                <dd>{selected.directory}</dd>
                <dt>{t('detail.preset')}</dt>
                <dd>{selected.preset}</dd>
                <dt>{t('detail.permission')}</dt>
                <dd>{selected.permissionPreset ?? t('detail.deploymentDefault')}</dd>
                <dt>{t('detail.model')}</dt>
                <dd>
                  {selected.model === undefined
                    ? t('detail.deploymentDefault')
                    : selected.model.reasoningEffort === undefined
                      ? `${selected.model.provider}/${selected.model.model}`
                      : t('detail.reasoning', {
                          model: `${selected.model.provider}/${selected.model.model}`,
                          effort: selected.model.reasoningEffort,
                        })}
                </dd>
                <dt>{t('detail.tools')}</dt>
                <dd>
                  {selected.allowedTools === undefined
                    ? t('detail.allTools')
                    : selected.allowedTools.length === 0
                      ? t('detail.noTools')
                      : selected.allowedTools.join(', ')}
                </dd>
                <dt>{t('detail.assignments')}</dt>
                <dd>{selected.assignmentCount}</dd>
                <dt>{t('detail.lastAssigned')}</dt>
                <dd>{selected.lastAssignedAt === undefined ? t('detail.never') : instant(selected.lastAssignedAt)}</dd>
              </dl>

              <div className={css.section}>
                <h3 className={css.sectionTitle}>{t('detail.assign')}</h3>
                <Field label={t('detail.assign')}>
                  <textarea
                    className={css.textarea}
                    value={assignText}
                    onChange={event => { setAssignText(event.target.value) }}
                    placeholder={t('detail.assignPlaceholder')}
                  />
                </Field>
                <div className={css.row}>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || assignText.trim() === ''}
                    onClick={() => { void assign(selected) }}
                  >
                    {t('detail.queue')}
                  </Button>
                  <span className={css.hint}>{t('detail.queueHint')}</span>
                </div>
              </div>

              <div className={css.section}>
                <h3 className={css.sectionTitle}>{t('detail.remember')}</h3>
                <Field label={t('detail.remember')}>
                  <textarea
                    className={css.textarea}
                    value={memoryText}
                    onChange={event => { setMemoryText(event.target.value) }}
                    placeholder={t('detail.rememberPlaceholder')}
                  />
                </Field>
                <div className={css.row}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || memoryText.trim() === ''}
                    onClick={() => { void remember(selected) }}
                  >
                    {t('detail.append')}
                  </Button>
                </div>
              </div>

              <div className={css.section}>
                <h3 className={css.sectionTitle}>{t('detail.toolsEdit')}</h3>
                <Field label={t('detail.toolsEdit')}>
                  <input
                    className={css.input}
                    value={toolsValue}
                    onChange={event => { setToolsDraft({ dot: selected.id, text: event.target.value }) }}
                    placeholder={t('create.toolsPlaceholder')}
                  />
                </Field>
                <p className={css.hint}>{t('detail.toolsHint')}</p>
                <div className={css.row}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => { void saveTools(selected, toolsValue) }}
                  >
                    {t('detail.toolsSave')}
                  </Button>
                </div>
              </div>

              <div className={css.section}>
                <h3 className={css.sectionTitle}>{t('detail.schedule')}</h3>
                {schedules.phase === 'ready'
                  ? schedules.records.length === 0
                    ? <p className={css.hint}>{t('detail.scheduleEmpty')}</p>
                    : (
                        <ul className={css.schedules}>
                          {schedules.records.map(record => (
                            <li key={record.id} className={css.scheduleRow}>
                              <span className={css.scheduleTitle}>{record.title}</span>
                              <span className={css.hint}>{instant(Date.parse(record.scheduledAt))}</span>
                            </li>
                          ))}
                        </ul>
                      )
                  : schedules.phase === 'loading'
                    ? <p className={css.hint}>{t('detail.scheduleLoading')}</p>
                    : null}
                <div className={css.formGrid}>
                  <Field label={t('detail.scheduleTitle')}>
                    <input
                      className={css.input}
                      value={scheduleTitle}
                      onChange={event => { setScheduleTitle(event.target.value) }}
                      placeholder={t('detail.scheduleTitlePlaceholder')}
                    />
                  </Field>
                  <Field label={t('detail.scheduleDelay')}>
                    <input
                      className={css.input}
                      inputMode="numeric"
                      value={scheduleDelay}
                      onChange={event => { setScheduleDelay(event.target.value) }}
                    />
                  </Field>
                </div>
                <Field label={t('detail.schedulePrompt')}>
                  <textarea
                    className={css.textarea}
                    value={schedulePrompt}
                    onChange={event => { setSchedulePrompt(event.target.value) }}
                    placeholder={t('detail.schedulePrompt')}
                  />
                </Field>
                <div className={css.row}>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { void createSchedule(selected) }}>
                    {t('detail.scheduleCreate')}
                  </Button>
                  <span className={css.hint}>{t('detail.scheduleHint')}</span>
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {confirming !== null && (
        <Modal
          open
          onClose={() => { setConfirming(null) }}
          title={t('confirm.title')}
          closeLabel={t('close')}
          footer={
            <>
              <Button variant="outline" onClick={() => { setConfirming(null) }}>
                {t('confirm.cancel')}
              </Button>
              <Button
                variant="primary"
                className={css.confirmDanger}
                disabled={busy}
                onClick={() => { void archive(confirming) }}
              >
                {t('confirm.confirm')}
              </Button>
            </>
          }
        >
          <p className={css.confirmBody}>{t('confirm.archive', { name: confirming.name })}</p>
        </Modal>
      )}
    </section>
  )
}

/** One labeled form control. */
function Field({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <label className={css.field}>
      <span className={css.label}>{label}</span>
      {children}
    </label>
  )
}
