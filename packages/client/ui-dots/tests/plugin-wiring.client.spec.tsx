// @vitest-environment jsdom
/** Browser wiring of the Dots page and its Sidebar entry. */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { DotView } from '@deepseek-ai/dsh-dots/types'
import { apply, inject } from '../src/client/index.ts'
import type { DotsPanelInjected } from '../src/client/DotsPanel.tsx'

let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

function dot(view: Partial<DotView> = {}): DotView {
  return {
    id: 'dot-researcher' as DotView['id'],
    name: 'researcher',
    purpose: 'Keep the release notes current.',
    directory: '/home/dots/researcher',
    sessionId: 'session-dot-researcher',
    preset: 'standard',
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    assignmentCount: 0,
    status: 'idle',
    ...view,
  }
}

async function bench() {
  const created = await SlotTestRuntime.create()
  runtime = created
  const listed = dot()
  const dots = {
    list: vi.fn(async () => ({ ok: true as const, value: { dots: [listed] } })),
    create: vi.fn(async () => ({ ok: true as const, value: { view: listed, warnings: [] } })),
    assign: vi.fn(async () => ({
      ok: true as const,
      value: { accepted: true as const, dotId: listed.id, sessionId: listed.sessionId, status: 'queued' as const },
    })),
    update: vi.fn(async () => ({ ok: true as const, value: listed })),
    archive: vi.fn(async () => ({
      ok: true as const,
      value: { archived: true as const, dotId: listed.id, deletedSchedules: 0 },
    })),
    scheduleList: vi.fn(async () => ({ ok: true as const, value: { schedules: [] } })),
    scheduleCreate: vi.fn(async () => ({
      ok: true as const,
      value: { id: 'schedule-1', kind: 'after', title: 'Daily check', scheduledAt: '2026-10-27T00:00:00.000Z' },
    })),
  }
  created.remote.provideNamespaces({ dots })
  const openSession = vi.fn<(sessionId: string) => void>()
  created.ctx.provide('uiWorkspace', { openSession } as never)
  const locale = new LocaleRuntime(created.ctx)
  created.ctx.provide('locale', locale)
  created.slots.installLocale(locale)
  await created.root.declare({
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  }, () => null)
  const handle = await created.mount({ inject: [...inject], apply })
  return { runtime: created, handle, dots, openSession }
}

describe('Dots browser plugin', () => {
  it('registers the main page and the Sidebar entry', async () => {
    const { runtime: running, handle } = await bench()

    const page = running.slots.entries('main').find(entry => entry.options.key === 'dots')
    expect(page).toBeDefined()
    expect(page?.locale).toBe('dots')

    const entry = running.slots.entries('sidebar.panellist').find(item => item.options.id === 'dots')
    expect(entry).toBeDefined()
    expect(entry?.options).toMatchObject({ order: 20 })
    expect(entry?.locale).toBe('dots')
    expect(resolveSlotLabel(entry?.options.label)).toBe('Dots')

    await handle.dispose()
  })

  it('opens the dot home Session through the Workspace service', async () => {
    const { runtime: running, handle, dots, openSession } = await bench()
    const page = running.slots.entries('main').find(entry => entry.options.key === 'dots')
    const face = (page?.inject as (() => DotsPanelInjected) | undefined)?.()
    if (face === undefined) throw new Error('the dots page has no inject face')

    expect(face.remote).toBe(dots)
    face.openSession('session-dot-researcher')
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-dot-researcher')

    await handle.dispose()
  })

  it('removes both entries when the plugin fiber is disposed', async () => {
    const { runtime: running, handle } = await bench()
    expect(running.slots.entries('main').some(entry => entry.options.key === 'dots')).toBe(true)

    await handle.dispose()

    expect(running.slots.entries('main').some(entry => entry.options.key === 'dots')).toBe(false)
    expect(running.slots.entries('sidebar.panellist').some(entry => entry.options.id === 'dots')).toBe(false)
  })
})
