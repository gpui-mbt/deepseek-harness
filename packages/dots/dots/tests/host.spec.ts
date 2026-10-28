import { afterEach, describe, expect, it } from 'vite-plus/test'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ScheduleId, ScheduleService } from '@deepseek-ai/dsh-schedule'
import type { ScheduleCreateRequest } from '@deepseek-ai/dsh-schedule'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { createDotsHost } from '../src/host.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/**
 * Build one service value whose prototype keeps the declared type.
 *
 * The adapter reads only the members a dots composition calls, so the suite
 * supplies those members and leaves the rest of the real class unreachable.
 * @param type - real service class whose prototype is retained.
 * @param members - the subset of members under test.
 * @returns the stub service value.
 */
function stub<T extends object>(type: { prototype: object }, members: Partial<T>): T {
  return Object.assign(Object.create(type.prototype), members) as T
}

/** Recorded Session-controller calls. */
interface SessionCalls {
  creates: Array<{ readonly workspaceId?: string; readonly cwd?: string; readonly agentPreset?: string }>
  renames: Array<{ readonly sessionId: string; readonly title: string }>
  prompts: SessionPromptRequest[]
  selections: Array<{ readonly sessionId: string; readonly provider: string; readonly model: string }>
}

/**
 * Create a stub Session controller.
 * @returns the controller and its recorded calls.
 */
function sessionController(calls: SessionCalls): SessionController {
  return stub<SessionController>(SessionController, {
    async create(request) {
      calls.creates.push(request)
      return { sessionId: SessionId('session-1') }
    },
    async rename(request) {
      calls.renames.push(request)
      return { title: request.title, seq: 0 }
    },
    async list() {
      return {
        items: [
          {
            sessionId: SessionId('session-1'),
            updatedAt: 0,
            running: true,
            agentAvailable: true,
            blank: false,
          },
          {
            sessionId: SessionId('session-2'),
            updatedAt: 0,
            running: false,
            agentAvailable: false,
            blank: true,
          },
        ],
      }
    },
    async modelCatalog() {
      return {
        default: { provider: 'deepseek', model: 'flash' },
        routableProviders: ['deepseek'],
        groups: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            models: [
              {
                id: 'flash',
                name: 'Flash',
                description: 'Fast',
                reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
              },
              { id: 'pro', name: 'Pro' },
              { id: 'mini', name: 'Mini', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
            ],
          },
        ],
        failures: [{ id: 'broken', name: 'Broken', message: 'unavailable' }],
      }
    },
    async selectModel(request) {
      calls.selections.push(request)
      return { selected: { provider: request.provider, model: request.model } }
    },
    async prompt(request) {
      calls.prompts.push(request)
      return { accepted: true }
    },
  })
}

/**
 * Build one fake live Agent with an optional parent Session.
 * @param id - Session identity.
 * @param parentSession - parent Session identity for the lineage walk.
 * @returns the agent view.
 */
function agentOf(id: string, parentSession?: string): Agent {
  const cancelled: string[] = []
  return Object.assign(Object.create(null), {
    id: SessionId(id),
    status: 'running',
    session: { id: SessionId(id), header: { parentSession: parentSession === undefined ? undefined : SessionId(parentSession) } },
    cancel: (cause: { readonly kind: 'user' }) => {
      cancelled.push(cause.kind)
    },
  }) as Agent
}

/** Recorded schedule calls. */
interface ScheduleCalls {
  creates: Array<{ readonly sessionId: string; readonly request: ScheduleCreateRequest }>
  deletes: Array<{ readonly sessionId: string; readonly id: string }>
}

describe('dots Host adapter', () => {
  it('creates a Session from a directory or a Workspace binding', async () => {
    const calls: SessionCalls = { creates: [], renames: [], prompts: [], selections: [] }
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionController', sessionController(calls))
    const host = createDotsHost(ctx)
    await expect(host.createSession({ directory: '/tmp/dot', preset: 'standard' })).resolves.toEqual({
      sessionId: 'session-1',
    })
    await host.createSession({ directory: '/tmp/dot', workspaceId: 'workspace-1', preset: 'creator' })
    expect(calls.creates).toEqual([
      { cwd: '/tmp/dot', agentPreset: 'standard' },
      { workspaceId: 'workspace-1', agentPreset: 'creator' },
    ])
  })

  it('renames a Session with the branded identity', async () => {
    const calls: SessionCalls = { creates: [], renames: [], prompts: [], selections: [] }
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionController', sessionController(calls))
    await createDotsHost(ctx).renameSession('session-1', 'researcher')
    expect(calls.renames).toEqual([{ sessionId: 'session-1', title: 'researcher' }])
  })

  it('maps the Session list onto dot status facts', async () => {
    const calls: SessionCalls = { creates: [], renames: [], prompts: [], selections: [] }
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionController', sessionController(calls))
    await expect(createDotsHost(ctx).listSessions()).resolves.toEqual([
      { sessionId: 'session-1', running: true, agentAvailable: true },
      { sessionId: 'session-2', running: false, agentAvailable: false },
    ])
  })

  it('maps the model catalog and selects a Session model', async () => {
    const calls: SessionCalls = { creates: [], renames: [], prompts: [], selections: [] }
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionController', sessionController(calls))
    const host = createDotsHost(ctx)
    await expect(host.listModels()).resolves.toMatchObject({
      default: { provider: 'deepseek', model: 'flash' },
      groups: [
        {
          id: 'deepseek',
          models: [
            {
              id: 'flash',
              description: 'Fast',
              efforts: [{ id: 'high', name: 'High' }],
              defaultEffort: 'high',
            },
            { id: 'pro' },
            { id: 'mini', name: 'Mini', efforts: [{ id: 'low', name: 'Low' }] },
          ],
        },
      ],
      failures: [{ id: 'broken', name: 'Broken', message: 'unavailable' }],
    })
    await host.selectModel('session-1', { provider: 'deepseek', model: 'flash', reasoningEffort: 'high' })
    expect(calls.selections).toEqual([
      { sessionId: 'session-1', provider: 'deepseek', model: 'flash', reasoningEffort: 'high' },
    ])
  })

  it('queues a prompt with the assignment identity and queue mode', async () => {
    const calls: SessionCalls = { creates: [], renames: [], prompts: [], selections: [] }
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionController', sessionController(calls))
    await createDotsHost(ctx).prompt('session-1', 'Do the work.', 'abc123')
    expect(calls.prompts).toEqual([
      {
        requestId: 'abc123',
        sessionId: 'session-1',
        mode: 'queue',
        content: [{ type: 'text', text: 'Do the work.' }],
      },
    ])
  })

  it('exposes live agents and walks their Session ancestry', async () => {
    const ctx = new Context()
    context = ctx
    const agents = new Map<string, Agent>([
      ['session-1', agentOf('session-1')],
      ['session-2', agentOf('session-2', 'session-1')],
      ['session-3', agentOf('session-3', 'session-2')],
    ])
    ctx.provide('agents', stub<AgentRegistry>(AgentRegistry, { get: (id: string) => agents.get(id) }))
    const host = createDotsHost(ctx)
    const live = host.getAgent('session-2')
    expect(live).toMatchObject({ id: 'session-2', status: 'running' })
    live?.cancel({ kind: 'user' })
    expect(host.getAgent('missing')).toBeUndefined()
    expect(host.parentSessions('session-3')).toEqual(['session-2', 'session-1'])
    expect(host.parentSessions('session-1')).toEqual([])
  })

  it('applies a permission preset to the live Session', async () => {
    const ctx = new Context()
    context = ctx
    const applied: Array<{ readonly session: unknown; readonly name: string }> = []
    const agents = new Map<string, Agent>([['session-1', agentOf('session-1')]])
    ctx.provide('agents', stub<AgentRegistry>(AgentRegistry, { get: (id: string) => agents.get(id) }))
    ctx.provide(
      'permissionPresets',
      stub<PermissionPresetService>(PermissionPresetService, {
        set: (session, name) => {
          applied.push({ session, name })
        },
      }),
    )
    await createDotsHost(ctx).setPermissionPreset('session-1', 'workspace-write')
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ session: { header: {} }, name: 'workspace-write' })
    // The adapter reports a missing live Agent synchronously: the caller awaits
    // the optional result inside its own try/catch.
    expect(() => createDotsHost(ctx).setPermissionPreset('missing', 'workspace-write')).toThrow(
      /has no live agent/u,
    )
  })

  it('reports unavailable optional services', async () => {
    const calls: SessionCalls = { creates: [], renames: [], prompts: [], selections: [] }
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionController', sessionController(calls))
    const host = createDotsHost(ctx)
    await expect(host.createWorkspace('/tmp/dot', 'dot')).resolves.toBeUndefined()
    expect(() => host.setPermissionPreset('session-1', 'workspace-write')).toThrow(/no permission-preset/u)
    await expect(
      host.createSchedule('session-1', { title: 'Check', prompt: 'Check.', every_seconds: 60 }),
    ).rejects.toMatchObject({ code: 'dots/unavailable' })
    await expect(host.listSchedules('session-1')).rejects.toMatchObject({ code: 'dots/unavailable' })
    await expect(host.deleteSchedule('session-1', 'schedule-1')).rejects.toMatchObject({ code: 'dots/unavailable' })
  })

  it('registers a Workspace when the registry is mounted', async () => {
    const calls: SessionCalls = { creates: [], renames: [], prompts: [], selections: [] }
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionController', sessionController(calls))
    ctx.provide(
      'workspaceRegistry',
      stub<WorkspaceRegistry>(WorkspaceRegistry, {
        create: async () => Object.assign(Object.create(null), { id: 'workspace-1' }) as Workspace,
      }),
    )
    await expect(createDotsHost(ctx).createWorkspace('/tmp/dot', 'dot')).resolves.toEqual({ id: 'workspace-1' })
  })

  it('copies every accepted schedule selector and drops the absent ones', async () => {
    const calls: SessionCalls = { creates: [], renames: [], prompts: [], selections: [] }
    const created: ScheduleCreateRequest[] = []
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionController', sessionController(calls))
    ctx.provide(
      'schedule',
      stub<ScheduleService>(ScheduleService, {
        create: async (_sessionId, request) => {
          created.push(request)
          return {
            id: ScheduleId(`schedule-${created.length}`),
            kind: 'after',
            title: request.title,
            prompt: request.prompt,
            afterSeconds: request.after_seconds ?? 60,
            scheduledAt: '2099-01-01T00:00:00.000Z',
          }
        },
      }),
    )
    const host = createDotsHost(ctx)
    await host.createSchedule('session-1', { title: 'A', prompt: 'A.', after_seconds: 60 })
    await host.createSchedule('session-1', { title: 'B', prompt: 'B.', at: '2099-01-01T00:00:00.000Z' })
    await host.createSchedule('session-1', {
      title: 'C',
      prompt: 'C.',
      at: { date: '2099-01-01', time: '09:00:00', time_zone: 'UTC' },
    })
    await host.createSchedule('session-1', { title: 'D', prompt: 'D.', every_seconds: 60 })
    await host.createSchedule('session-1', {
      title: 'E',
      prompt: 'E.',
      daily: { time: '09:00:00', time_zone: 'UTC' },
    })
    await host.createSchedule('session-1', {
      title: 'F',
      prompt: 'F.',
      weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1, 3] },
    })
    await host.createSchedule('session-1', {
      title: 'G',
      prompt: 'G.',
      cron: { expression: '*/5 * * * *', time_zone: 'UTC' },
    })
    await host.createSchedule('session-1', { title: 'H', prompt: 'H.' })
    expect(created.map(request => request.title)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
    expect(created[1]?.at).toBe('2099-01-01T00:00:00.000Z')
    expect(created[2]?.at).toEqual({ date: '2099-01-01', time: '09:00:00', time_zone: 'UTC' })
    expect(created[5]?.weekly).toEqual({ time: '09:00:00', time_zone: 'UTC', weekdays: [1, 3] })
    expect(created[6]?.cron).toEqual({ expression: '*/5 * * * *', time_zone: 'UTC' })
    expect(created[7]).not.toHaveProperty('after_seconds')
  })

  it('maps schedule requests and reads back schedule summaries', async () => {
    const calls: SessionCalls = { creates: [], renames: [], prompts: [], selections: [] }
    const scheduleCalls: ScheduleCalls = { creates: [], deletes: [] }
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionController', sessionController(calls))
    ctx.provide(
      'schedule',
      stub<ScheduleService>(ScheduleService, {
        create: async (sessionId, request) => {
          scheduleCalls.creates.push({ sessionId, request })
          return {
            id: ScheduleId('schedule-1'),
            kind: 'weekly',
            title: request.title,
            prompt: request.prompt,
            time: '09:00:00.000',
            timeZone: request.weekly?.time_zone ?? 'UTC',
            weekdays: request.weekly?.weekdays ?? [],
            scheduledAt: '2099-01-01T00:00:00.000Z',
          }
        },
        list: async () => [
          {
            id: ScheduleId('schedule-1'),
            kind: 'weekly',
            title: 'Weekly review',
            prompt: 'Review.',
            time: '09:00:00.000',
            timeZone: 'Asia/Tokyo',
            weekdays: [1],
            scheduledAt: '2099-01-01T00:00:00.000Z',
          },
        ],
        delete: async request => {
          scheduleCalls.deletes.push(request)
          return { id: request.id, deleted: true }
        },
      }),
    )
    const host = createDotsHost(ctx)
    const created = await host.createSchedule('session-1', {
      title: 'Weekly review',
      prompt: 'Review.',
      weekly: { time: '09:00:00', time_zone: 'Asia/Tokyo', weekdays: [1] },
    })
    expect(created).toEqual({
      id: 'schedule-1',
      kind: 'weekly',
      title: 'Weekly review',
      scheduledAt: '2099-01-01T00:00:00.000Z',
    })
    expect(scheduleCalls.creates[0]?.request.weekly).toEqual({
      time: '09:00:00',
      time_zone: 'Asia/Tokyo',
      weekdays: [1],
    })
    await expect(host.listSchedules('session-1')).resolves.toEqual([
      {
        id: 'schedule-1',
        kind: 'weekly',
        title: 'Weekly review',
        scheduledAt: '2099-01-01T00:00:00.000Z',
      },
    ])
    await host.deleteSchedule('session-1', 'schedule-1')
    expect(scheduleCalls.deletes).toEqual([{ sessionId: 'session-1', id: 'schedule-1' }])
    expect(host.now()).toBeGreaterThan(0)
  })
})
