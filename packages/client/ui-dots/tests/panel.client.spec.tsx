// @vitest-environment jsdom
/** Dots page presentation: list, creation, detail mutations, schedules, and failure copy. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DotId, DotView, ScheduleRecordLike } from '@deepseek-ai/dsh-dots/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { DotsIcon } from '../src/client/DotsIcon.tsx'
import { DotsPanel } from '../src/client/DotsPanel.tsx'
import type { DotsPanelInjected, DotsPanelProps } from '../src/client/DotsPanel.tsx'
import { en } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

type DotsRemote = DotsPanelInjected['remote']

const t: PropsLocale<'dots'>['t'] = (key, params) => {
  const template = (en as Readonly<Record<string, string>>)[key] ?? key
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  })
}

const success = <T,>(value: T): RemoteResult<T> => ({ ok: true, value })

/** One dot fixture; every optional field stays absent unless the case sets it. */
function dot(overrides: Partial<DotView> = {}): DotView {
  return {
    id: 'dot-researcher' as DotId,
    name: 'researcher',
    purpose: 'Keep the release notes current.',
    directory: '/home/dots/researcher',
    sessionId: 'session-dot-researcher',
    preset: 'standard',
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    assignmentCount: 0,
    status: 'idle',
    ...overrides,
  }
}

function remoteStub(overrides: Partial<DotsRemote> = {}): DotsRemote {
  return {
    list: vi.fn<DotsRemote['list']>(async () => success({ dots: [dot()] })),
    create: vi.fn<DotsRemote['create']>(async () => success({ view: dot(), warnings: [] })),
    assign: vi.fn<DotsRemote['assign']>(async () => success({
      accepted: true,
      dotId: 'dot-researcher' as DotId,
      sessionId: 'session-dot-researcher',
      status: 'queued',
    })),
    update: vi.fn<DotsRemote['update']>(async () => success(dot())),
    archive: vi.fn<DotsRemote['archive']>(async () => success({
      archived: true,
      dotId: 'dot-researcher' as DotId,
      deletedSchedules: 0,
    })),
    scheduleList: vi.fn<DotsRemote['scheduleList']>(async () => success({ schedules: [] })),
    scheduleCreate: vi.fn<DotsRemote['scheduleCreate']>(async () => success({
      id: 'schedule-2',
      kind: 'after',
      title: 'Follow up',
      scheduledAt: '2026-10-28T00:00:00.000Z',
    })),
    ...overrides,
  }
}

function mount(remote: DotsRemote, openSession = vi.fn<(sessionId: string) => void>()) {
  return render(<DotsPanel {...({ remote, openSession, t } as DotsPanelProps)} />)
}

function failure<T>(message: string): RemoteResult<T> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

function toolsValue(): string {
  const element = screen.getByLabelText(en['detail.toolsEdit'])
  if (!(element instanceof HTMLInputElement)) throw new Error('the tools editor is not an input')
  return element.value
}

function form(): HTMLFormElement {
  const submit = screen.getByRole('button', { name: en['create.create'] })
  const parent = submit.closest('form')
  if (parent === null) throw new Error('the create action is not inside a form')
  return parent
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('DotsPanel', () => {
  it('renders the loading line, then the dot list with status chips and card metadata', async () => {
    const researcher = dot({
      status: 'running',
      workspaceId: 'workspace-1',
      permissionPreset: 'workspace-write',
      model: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' },
      assignmentCount: 1,
      lastAssignedAt: 1_760_000_100_000,
    })
    const planner = dot({
      id: 'dot-planner' as DotId,
      name: 'planner',
      purpose: 'Keep the roadmap current.',
      status: 'missing',
      model: { provider: 'deepseek', model: 'deepseek-v4' },
      allowedTools: [],
      assignmentCount: 3,
    })
    const archivist = dot({
      id: 'dot-archivist' as DotId,
      name: 'archivist',
      purpose: 'File the weekly digests.',
      status: 'idle',
      allowedTools: ['read'],
      assignmentCount: 0,
    })
    mount(remoteStub({ list: vi.fn(async () => success({ dots: [researcher, planner, archivist] })) }))

    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(await screen.findAllByText('researcher')).toBeTruthy()

    expect(screen.getAllByText(en['status.running'])).toHaveLength(2)
    expect(screen.getByText(en['status.missing'])).toBeTruthy()
    expect(screen.getByText(en['status.idle'])).toBeTruthy()
    expect(screen.getByText('1 assignment')).toBeTruthy()
    expect(screen.getByText('3 assignments')).toBeTruthy()
    expect(screen.getByText('0 assignments')).toBeTruthy()
    expect(screen.getAllByText(en['card.never'])).toHaveLength(2)
    expect(screen.getByText('workspace-1')).toBeTruthy()
    expect(screen.getByText('/home/dots/researcher')).toBeTruthy()
    expect(screen.getByText('deepseek/deepseek-v4 (high)')).toBeTruthy()
    expect(screen.getByText(en['detail.allTools'])).toBeTruthy()
  })

  it('follows the selected dot and drops unsaved per-dot drafts', async () => {
    const researcher = dot({ status: 'running' })
    const planner = dot({
      id: 'dot-planner' as DotId,
      name: 'planner',
      model: { provider: 'deepseek', model: 'deepseek-v4' },
      allowedTools: [],
    })
    const archivist = dot({
      id: 'dot-archivist' as DotId,
      name: 'archivist',
      allowedTools: ['read'],
    })
    mount(remoteStub({ list: vi.fn(async () => success({ dots: [researcher, planner, archivist] })) }))
    await screen.findAllByText('researcher')

    fireEvent.click(screen.getByRole('button', { name: /^planner/u }))
    expect(screen.getByText('deepseek/deepseek-v4')).toBeTruthy()
    expect(screen.getByText(en['detail.noTools'])).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^archivist/u }))
    expect(screen.getAllByText(en['detail.deploymentDefault'])).toHaveLength(2)
    expect(screen.getByText('read')).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en['detail.toolsEdit']), { target: { value: 'grep' } })
    expect(toolsValue()).toBe('grep')

    fireEvent.click(screen.getByRole('button', { name: /^researcher/u }))
    expect(toolsValue()).toBe('')
  })

  it('creates a dot from trimmed values and reports Host warnings', async () => {
    const create = vi.fn(async () => success({
      view: dot({ id: 'dot-planner' as DotId, name: 'planner' }),
      warnings: ['preset not found'],
    }))
    mount(remoteStub({ create }))
    await screen.findAllByText('researcher')

    fireEvent.click(screen.getByRole('button', { name: en.new }))
    fireEvent.change(screen.getByLabelText(en['create.name']), { target: { value: '  planner  ' } })
    fireEvent.change(screen.getByLabelText(en['create.purpose']), { target: { value: '  Keep the roadmap current.  ' } })
    fireEvent.change(screen.getByLabelText(en['create.preset']), { target: { value: 'standard' } })
    fireEvent.change(screen.getByLabelText(en['create.permission']), { target: { value: 'workspace-write' } })
    fireEvent.change(screen.getByLabelText(en['create.tools']), { target: { value: 'read, grep, web_search' } })
    fireEvent.submit(form())

    await waitFor(() => {
      expect(create).toHaveBeenCalledExactlyOnceWith({
        name: 'planner',
        purpose: 'Keep the roadmap current.',
        preset: 'standard',
        permissionPreset: 'workspace-write',
        allowedTools: ['read', 'grep', 'web_search'],
      })
    })
    expect(await screen.findByText(t('notice.createdWithWarnings', { name: 'planner', warnings: 'preset not found' })))
      .toBeTruthy()
    expect(screen.queryByLabelText(en['create.name'])).toBeNull()
  })

  it('creates a dot from the required fields only', async () => {
    const create = vi.fn(async () => success({ view: dot({ id: 'dot-scribe' as DotId, name: 'scribe' }), warnings: [] }))
    mount(remoteStub({ create }))
    await screen.findAllByText('researcher')

    fireEvent.click(screen.getByRole('button', { name: en.new }))
    fireEvent.change(screen.getByLabelText(en['create.name']), { target: { value: 'scribe' } })
    fireEvent.change(screen.getByLabelText(en['create.purpose']), { target: { value: 'Draft changelogs.' } })
    fireEvent.submit(form())

    await waitFor(() => {
      expect(create).toHaveBeenCalledExactlyOnceWith({ name: 'scribe', purpose: 'Draft changelogs.' })
    })
    expect(await screen.findByText(t('notice.created', { name: 'scribe' }))).toBeTruthy()
  })

  it('queues an assignment and reloads the authoritative list', async () => {
    const researcher = dot({ status: 'running' })
    const list = vi.fn()
      .mockResolvedValueOnce(success({ dots: [researcher] }))
      .mockResolvedValueOnce(success({ dots: [{ ...researcher, assignmentCount: 2 }] }))
    const assign = vi.fn(async () => success({
      accepted: true as const,
      dotId: researcher.id,
      sessionId: researcher.sessionId,
      status: 'queued' as const,
    }))
    mount(remoteStub({ list, assign }))
    await screen.findAllByText('researcher')

    fireEvent.change(screen.getByLabelText(en['detail.assign']), { target: { value: 'Write the release notes.' } })
    fireEvent.click(screen.getByRole('button', { name: en['detail.queue'] }))

    await waitFor(() => {
      expect(assign).toHaveBeenCalledExactlyOnceWith({ dot: researcher.id, task: 'Write the release notes.' })
    })
    expect(await screen.findByText(en['notice.assignmentQueued'])).toBeTruthy()
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2)
    })
    expect(await screen.findByText('2 assignments')).toBeTruthy()
  })

  it('appends memory, saves the tool allowlist, and rejects an empty allowlist', async () => {
    const researcher = dot({ allowedTools: ['read'] })
    const update = vi.fn(async () => success(researcher))
    mount(remoteStub({ list: vi.fn(async () => success({ dots: [researcher] })), update }))
    await screen.findAllByText('researcher')

    fireEvent.change(screen.getByLabelText(en['detail.remember']), { target: { value: 'Prefer short replies.' } })
    fireEvent.click(screen.getByRole('button', { name: en['detail.append'] }))
    await waitFor(() => {
      expect(update).toHaveBeenCalledExactlyOnceWith({ dot: researcher.id, addMemory: 'Prefer short replies.' })
    })
    expect(await screen.findByText(en['notice.memoryAppended'])).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en['detail.toolsEdit']), { target: { value: 'read, web_fetch' } })
    fireEvent.click(screen.getByRole('button', { name: en['detail.toolsSave'] }))
    await waitFor(() => {
      expect(update).toHaveBeenLastCalledWith({ dot: researcher.id, allowedTools: ['read', 'web_fetch'] })
    })
    expect(await screen.findByText(en['notice.toolsSaved'])).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en['detail.toolsEdit']), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: en['detail.toolsSave'] }))
    expect((await screen.findByRole('alert')).textContent).toContain(en['error.toolsRequired'])
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('lists active schedules and creates one after a delay', async () => {
    const researcher = dot()
    const record: ScheduleRecordLike = {
      id: 'schedule-1',
      kind: 'after',
      title: 'Daily check',
      scheduledAt: '2026-10-27T00:00:00.000Z',
    }
    const scheduleCreate = vi.fn(async () => success({
      id: 'schedule-2',
      kind: 'after',
      title: 'Follow up',
      scheduledAt: '2026-10-28T00:00:00.000Z',
    }))
    mount(remoteStub({
      list: vi.fn(async () => success({ dots: [researcher] })),
      scheduleList: vi.fn(async () => success({ schedules: [record] })),
      scheduleCreate,
    }))
    await screen.findAllByText('researcher')
    expect(await screen.findByText('Daily check')).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en['detail.scheduleTitle']), { target: { value: '  Follow up  ' } })
    fireEvent.change(screen.getByLabelText(en['detail.scheduleDelay']), { target: { value: '120' } })
    fireEvent.change(screen.getByLabelText(en['detail.schedulePrompt']), {
      target: { value: '  Check the review thread.  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: en['detail.scheduleCreate'] }))

    await waitFor(() => {
      expect(scheduleCreate).toHaveBeenCalledExactlyOnceWith({
        dot: researcher.id,
        title: 'Follow up',
        prompt: 'Check the review thread.',
        after_seconds: 120,
      })
    })
    expect(await screen.findByText('Follow up')).toBeTruthy()
    expect(screen.getByText(en['notice.scheduleCreated'])).toBeTruthy()
  })

  it('validates the schedule form before calling the Host', async () => {
    const scheduleCreate = vi.fn(async () => success({
      id: 'schedule-2',
      kind: 'after',
      title: 'Follow up',
      scheduledAt: '2026-10-28T00:00:00.000Z',
    }))
    mount(remoteStub({ list: vi.fn(async () => success({ dots: [dot()] })), scheduleCreate }))
    await screen.findAllByText('researcher')

    fireEvent.click(screen.getByRole('button', { name: en['detail.scheduleCreate'] }))
    expect((await screen.findByRole('alert')).textContent).toContain(en['error.scheduleRequired'])

    fireEvent.change(screen.getByLabelText(en['detail.scheduleTitle']), { target: { value: 'Follow up' } })
    fireEvent.change(screen.getByLabelText(en['detail.scheduleDelay']), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText(en['detail.schedulePrompt']), { target: { value: 'Check the review.' } })
    fireEvent.click(screen.getByRole('button', { name: en['detail.scheduleCreate'] }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(en['error.delay'])
    })
    expect(scheduleCreate).not.toHaveBeenCalled()
  })

  it('archives a dot only after the confirmation dialog', async () => {
    const researcher = dot({ status: 'running' })
    const planner = dot({ id: 'dot-planner' as DotId, name: 'planner' })
    const archive = vi.fn(async () => success({
      archived: true as const,
      dotId: researcher.id,
      deletedSchedules: 1,
    }))
    mount(remoteStub({ list: vi.fn(async () => success({ dots: [researcher, planner] })), archive }))
    await screen.findAllByText('researcher')

    fireEvent.click(screen.getByRole('button', { name: en['detail.archive'] }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(t('confirm.archive', { name: 'researcher' }))).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(archive).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en['detail.archive'] }))
    const again = await screen.findByRole('dialog')
    fireEvent.click(within(again).getByRole('button', { name: en['confirm.confirm'] }))

    await waitFor(() => {
      expect(archive).toHaveBeenCalledExactlyOnceWith({ dot: researcher.id, stopSchedules: true })
    })
    expect(await screen.findByText(t('notice.archived', { name: 'researcher' }))).toBeTruthy()
    await waitFor(() => {
      expect(screen.queryByText('researcher')).toBeNull()
    })
  })

  it('opens the selected dot home Session in the current window', async () => {
    const researcher = dot()
    const openSession = vi.fn<(sessionId: string) => void>()
    mount(remoteStub({ list: vi.fn(async () => success({ dots: [researcher] })) }), openSession)
    await screen.findAllByText('researcher')

    fireEvent.click(screen.getByRole('button', { name: en['detail.openSession'] }))

    expect(openSession).toHaveBeenCalledExactlyOnceWith(researcher.sessionId)
  })

  it('draws the Sidebar glyph at the requested size', () => {
    const { container } = render(<DotsIcon {...({ size: 18, active: false } as PropsRuntime<'sidebar.panellist'>)} />)

    expect(container.querySelector('svg')?.getAttribute('width')).toBe('18')
    expect(container.querySelectorAll('circle')).toHaveLength(9)
  })

  it('ignores a list response that settles after unmount', async () => {
    let settle: (result: RemoteResult<{ dots: readonly DotView[] }>) => void = () => {}
    const list = vi.fn(() => new Promise<RemoteResult<{ dots: readonly DotView[] }>>(resolve => { settle = resolve }))
    const view = mount(remoteStub({ list }))
    view.unmount()

    await act(async () => {
      settle(success({ dots: [dot()] }))
    })

    expect(list).toHaveBeenCalledOnce()
  })

  it('refreshes the list on demand and reports a failed refresh', async () => {
    const researcher = dot({ assignmentCount: 0 })
    const list = vi.fn()
      .mockResolvedValueOnce(success({ dots: [researcher] }))
      .mockResolvedValueOnce(success({ dots: [{ ...researcher, assignmentCount: 4 }] }))
      .mockResolvedValueOnce(failure('refresh token=secret-value'))
    mount(remoteStub({ list }))
    await screen.findAllByText('researcher')

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(await screen.findByText('4 assignments')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect((await screen.findByRole('alert')).textContent).toContain(en['error.load'])
    expect(document.body.textContent).not.toContain('secret-value')
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('closes the creation form and the archive dialog without calling the Host', async () => {
    mount(remoteStub())
    await screen.findAllByText('researcher')

    fireEvent.click(screen.getByRole('button', { name: en.new }))
    fireEvent.click(screen.getByRole('button', { name: en['create.cancel'] }))
    expect(screen.queryByLabelText(en['create.name'])).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en['detail.archive'] }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the empty state when the deployment has no dots', async () => {
    mount(remoteStub({ list: vi.fn(async () => success({ dots: [] })) }))

    expect(await screen.findByText(en.empty)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a failed list without Remote details and without an empty state', async () => {
    mount(remoteStub({ list: vi.fn<DotsRemote['list']>(async () => failure('token=secret-value')) }))

    expect((await screen.findByRole('alert')).textContent).toContain(en['error.load'])
    expect(screen.queryByText(en.empty)).toBeNull()
    expect(document.body.textContent).not.toContain('secret-value')
  })

  it('reports a failed assignment and a rejected call through the same localized sentence', async () => {
    const researcher = dot()
    const assign = vi.fn()
      .mockResolvedValueOnce(failure<never>('access_token=private-value'))
      .mockRejectedValueOnce(new Error('assembly fault: access_token=private-value'))
    mount(remoteStub({ list: vi.fn(async () => success({ dots: [researcher] })), assign }))
    await screen.findAllByText('researcher')

    fireEvent.change(screen.getByLabelText(en['detail.assign']), { target: { value: 'Draft the summary.' } })
    fireEvent.click(screen.getByRole('button', { name: en['detail.queue'] }))
    expect((await screen.findByRole('alert')).textContent).toContain(en['error.assign'])
    expect(document.body.textContent).not.toContain('private-value')

    fireEvent.change(screen.getByLabelText(en['detail.assign']), { target: { value: 'Draft the summary.' } })
    fireEvent.click(screen.getByRole('button', { name: en['detail.queue'] }))
    await waitFor(() => {
      expect(assign).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByRole('alert').textContent).toContain(en['error.assign'])
    expect(document.body.textContent).not.toContain('private-value')
  })

  it('reports a failed creation without Remote details', async () => {
    const create = vi.fn<DotsRemote['create']>(async () => failure('name=secret-value'))
    mount(remoteStub({ create }))
    await screen.findAllByText('researcher')

    fireEvent.click(screen.getByRole('button', { name: en.new }))
    fireEvent.change(screen.getByLabelText(en['create.name']), { target: { value: 'planner' } })
    fireEvent.change(screen.getByLabelText(en['create.purpose']), { target: { value: 'Keep the roadmap current.' } })
    fireEvent.submit(form())

    expect((await screen.findByRole('alert')).textContent).toContain(en['error.create'])
    expect(document.body.textContent).not.toContain('secret-value')
  })

  it('keeps a failed schedule list usable and accepts a created schedule', async () => {
    const researcher = dot()
    const scheduleCreate = vi.fn(async () => success({
      id: 'schedule-2',
      kind: 'after',
      title: 'Follow up',
      scheduledAt: '2026-10-28T00:00:00.000Z',
    }))
    mount(remoteStub({
      list: vi.fn(async () => success({ dots: [researcher] })),
      scheduleList: vi.fn<DotsRemote['scheduleList']>(async () => failure('schedule store unavailable')),
      scheduleCreate,
    }))
    await screen.findAllByText('researcher')
    expect((await screen.findByRole('alert')).textContent).toContain(en['error.scheduleList'])
    expect(screen.queryByText(en['detail.scheduleEmpty'])).toBeNull()

    fireEvent.change(screen.getByLabelText(en['detail.scheduleTitle']), { target: { value: 'Follow up' } })
    fireEvent.change(screen.getByLabelText(en['detail.scheduleDelay']), { target: { value: '60' } })
    fireEvent.change(screen.getByLabelText(en['detail.schedulePrompt']), { target: { value: 'Check the review.' } })
    fireEvent.click(screen.getByRole('button', { name: en['detail.scheduleCreate'] }))

    expect(await screen.findByText('Follow up')).toBeTruthy()
    expect(scheduleCreate).toHaveBeenCalledOnce()
  })
})
