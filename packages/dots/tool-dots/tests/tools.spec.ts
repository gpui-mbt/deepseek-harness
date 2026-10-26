import { describe, expect, it, vi } from 'vite-plus/test'
import type { DotId, DotView } from '@deepseek-ai/dsh-dots'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineDotTools } from '../src/tools.ts'
import type { DotsToolService } from '../src/tools.ts'

const dotId = 'dot-researcher-a1b2c3' as DotId

const viewFixture: DotView = {
  id: dotId,
  name: 'researcher',
  purpose: 'Research.',
  directory: '/tmp/dots/dot-researcher-a1b2c3',
  sessionId: 'session-1',
  preset: 'standard',
  createdAt: 1,
  updatedAt: 1,
  assignmentCount: 0,
  status: 'idle',
}

/**
 * Build the execution slice the tools read.
 * `Object.create(null)` types as `any`, so the assertion records the test
 * double without an unknown hop; the tools read `signal` and `agent.id`.
 * @param sessionId - calling Session identity.
 * @returns the execution view.
 */
function execution(sessionId = 'main-session'): ToolRunContext {
  return Object.assign(Object.create(null), {
    signal: new AbortController().signal,
    agent: { id: sessionId },
  }) as ToolRunContext
}

/** Inert service used when one tool is under test. */
function service(overrides: Partial<Record<keyof DotsToolService, unknown>> = {}): DotsToolService {
  const base = {
    list: async () => ({ dots: [] }),
    create: async () => ({ view: viewFixture, warnings: [] }),
    assign: async () => ({ accepted: true as const, dotId, sessionId: 'session-1', status: 'queued' as const }),
    update: async () => viewFixture,
    archive: async () => ({ archived: true as const, dotId, deletedSchedules: 0 }),
    scheduleList: async () => ({ schedules: [] }),
    scheduleCreate: async () => ({
      id: 'sch-1',
      kind: 'every',
      title: 'Check',
      scheduledAt: '2099-01-01T00:00:00.000Z',
    }),
  } satisfies DotsToolService
  return Object.assign(base, overrides)
}

/**
 * Find one definition by name.
 * @param dots - service the definitions delegate to.
 * @param name - tool name.
 * @returns the definition.
 */
function toolOf(dots: DotsToolService, name: string) {
  const definition = defineDotTools(dots).find(item => item.name === name)
  if (definition === undefined) throw new Error(`missing tool ${name}`)
  return definition
}

describe('dot tool registration', () => {
  it('registers the six model-facing tools', () => {
    const definitions = defineDotTools(service())
    expect(definitions.map(definition => definition.name)).toEqual([
      'dot_create',
      'dot_list',
      'dot_assign',
      'dot_update',
      'dot_schedule',
      'dot_archive',
    ])
    for (const definition of definitions) {
      expect(definition.description.length).toBeGreaterThan(40)
      expect(definition.parameters).toBeTypeOf('object')
    }
  })

  it('keeps host routing out of the model-facing contract', () => {
    for (const definition of defineDotTools(service())) {
      expect(JSON.stringify(definition.parameters)).not.toContain('host')
      expect(definition.description).not.toMatch(/remote host|host:/iu)
    }
  })

  it('delegates create with snake_case mapping', async () => {
    const create = vi.fn(service().create)
    const definition = toolOf(service({ create }), 'dot_create')
    const result = await definition.execute(
      {
        name: 'researcher',
        purpose: 'Research.',
        permission_preset: 'workspace-write',
        allowed_tools: ['read'],
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        reasoning_effort: 'max',
      },
      execution(),
    )
    expect(create).toHaveBeenCalledWith(
      {
        name: 'researcher',
        purpose: 'Research.',
        permissionPreset: 'workspace-write',
        allowedTools: ['read'],
        model: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
      },
      expect.anything(),
    )
    expect(result).toMatchObject({ view: { id: dotId, name: 'researcher' }, warnings: [] })
  })

  it('rejects a provider without a model', async () => {
    const definition = toolOf(service(), 'dot_create')
    await expect(
      definition.execute({ name: 'researcher', purpose: 'Research.', provider: 'deepseek' }, execution()),
    ).rejects.toThrow(/provider and model/u)
  })

  it('assigns with the caller identity', async () => {
    const assign = vi.fn(service().assign)
    const definition = toolOf(service({ assign }), 'dot_assign')
    const result = await definition.execute(
      { dot: 'researcher', task: 'Draft the FAQ.' },
      execution('parent-session'),
    )
    expect(assign).toHaveBeenCalledWith(
      { dot: 'researcher', task: 'Draft the FAQ.', from: 'parent-session' },
      expect.anything(),
    )
    expect(result).toMatchObject({ accepted: true, status: 'queued' })
  })

  it('maps schedule selectors and rejects a malformed selector before the service', async () => {
    const scheduleCreate = vi.fn(service().scheduleCreate)
    const definition = toolOf(service({ scheduleCreate }), 'dot_schedule')
    const result = await definition.execute(
      {
        dot: 'researcher',
        title: 'Check',
        prompt: 'Check the FAQ.',
        weekly: { time: '09:00:00', time_zone: 'Asia/Tokyo', weekdays: [1, 3, 5] },
      },
      execution(),
    )
    expect(scheduleCreate).toHaveBeenCalledWith(
      {
        dot: 'researcher',
        title: 'Check',
        prompt: 'Check the FAQ.',
        weekly: { time: '09:00:00', time_zone: 'Asia/Tokyo', weekdays: [1, 3, 5] },
      },
      expect.anything(),
    )
    expect(result).toMatchObject({ id: 'sch-1' })

    await expect(
      definition.execute(
        { dot: 'researcher', title: 'Bad', prompt: 'x', cron: { expression: '* * * * *' } },
        execution(),
      ),
    ).rejects.toThrow(/cron\.time_zone/u)
    await expect(
      definition.execute(
        { dot: 'researcher', title: 'Bad', prompt: 'x', weekly: { time: '09:00', time_zone: 'UTC', weekdays: [] } },
        execution(),
      ),
    ).rejects.toThrow(/weekdays/u)
    await expect(
      definition.execute(
        { dot: 'researcher', title: 'Bad', prompt: 'x', weekly: { time: '09:00', time_zone: 'UTC', weekdays: [8] } },
        execution(),
      ),
    ).rejects.toThrow(/weekdays/u)
    await expect(
      definition.execute(
        { dot: 'researcher', title: 'Bad', prompt: 'x', daily: 'tomorrow' },
        execution(),
      ),
    ).rejects.toThrow(/daily must be an object/u)
    await expect(
      definition.execute(
        { dot: 'researcher', title: 'Bad', prompt: 'x', at: { date: '2099-01-01' } },
        execution(),
      ),
    ).rejects.toThrow(/at\.time/u)
  })

  it('renders and presents every definition', async () => {
    const dots = service()
    const argsByTool: Record<string, Record<string, unknown>> = {
      dot_create: { name: 'researcher', purpose: 'Research.' },
      dot_list: {},
      dot_assign: { dot: 'researcher', task: 'Draft the FAQ.' },
      dot_update: { dot: 'researcher' },
      dot_schedule: { dot: 'researcher', title: 'Check', prompt: 'Check.' },
      dot_archive: { dot: 'researcher' },
    }
    const value = {
      view: { id: dotId, name: 'researcher' },
      warnings: [],
      dots: [],
      dotId,
      sessionId: 'session-1',
      id: 'sch-1',
    }
    for (const definition of defineDotTools(dots)) {
      const args = argsByTool[definition.name]!
      const rendered = definition.output.render(args, value)
      expect(rendered.length, definition.name).toBeGreaterThan(0)
      expect(definition.presentCall?.(args), definition.name).toMatchObject({ card: 'generic' })
    }
    // The assignment renderer falls back to placeholders for a non-object result.
    const assign = toolOf(dots, 'dot_assign')
    expect(JSON.stringify(assign.output.render({}, null))).toContain('(unknown)')
  })

  it('covers present and absent optional fields and arguments', async () => {
    const fullView: DotView = {
      ...viewFixture,
      workspaceId: 'workspace-1',
      permissionPreset: 'workspace-write',
      allowedTools: ['read'],
      model: { provider: 'deepseek', model: 'flash', reasoningEffort: 'high' },
      lastAssignedAt: 5,
      archivedAt: 6,
    }
    const modelOnly: DotView = { ...viewFixture, model: { provider: 'deepseek', model: 'flash' } }
    let created = 0
    let updated = 0
    let archived = 0
    const dots = service({
      create: async () => ({ view: created++ === 0 ? fullView : modelOnly, warnings: [] }),
      update: async () => (updated++ === 0 ? fullView : modelOnly),
      archive: async () =>
        archived++ === 0
          ? { archived: true as const, dotId, deletedSchedules: 2, warnings: ['kept'] }
          : { archived: true as const, dotId, deletedSchedules: 0 },
    })

    const create = toolOf(dots, 'dot_create')
    await create.execute({ name: 'research', purpose: 'Research.' }, execution())
    await create.execute(
      { name: 'research', purpose: 'Research.', provider: 'deepseek', model: 'flash' },
      execution(),
    )
    await create.execute(
      {
        name: 'research',
        purpose: 'Research.',
        preset: 'standard',
        permission_preset: 'workspace-write',
        allowed_tools: ['read'],
        provider: 'deepseek',
        model: 'flash',
        reasoning_effort: 'high',
      },
      execution(),
    )

    const update = toolOf(dots, 'dot_update')
    await update.execute({ dot: 'research' }, execution())
    await update.execute(
      { dot: 'research', purpose: 'Updated.', add_memory: 'Note.', allowed_tools: ['read'] },
      execution(),
    )

    const assign = toolOf(dots, 'dot_assign')
    const withoutAgent = Object.assign(Object.create(null), {
      signal: new AbortController().signal,
    }) as ToolRunContext
    await assign.execute({ dot: 'research', task: 'Work.' }, withoutAgent)
    expect(JSON.stringify(assign.output.render({}, { dotId: 7, sessionId: 8 }))).toContain('(unknown)')

    const schedule = toolOf(dots, 'dot_schedule')
    await schedule.execute(
      { dot: 'research', title: 'Check', prompt: 'Check.', at: '2099-01-01T00:00:00.000Z' },
      execution(),
    )
    await schedule.execute(
      { dot: 'research', title: 'Check', prompt: 'Check.', every_seconds: 60 },
      execution(),
    )
    await schedule.execute(
      { dot: 'research', title: 'Check', prompt: 'Check.', after_seconds: 90 },
      execution(),
    )

    const archive = toolOf(dots, 'dot_archive')
    const withWarnings = await archive.execute({ dot: 'research' }, execution())
    expect(withWarnings).toMatchObject({ deletedSchedules: 2, warnings: ['kept'] })
    const withoutWarnings = await archive.execute({ dot: 'research' }, execution())
    expect(withoutWarnings).not.toHaveProperty('warnings')
  })

  it('archives with schedules stopped unless the caller opts out', async () => {
    const archive = vi.fn(service().archive)
    const definition = toolOf(service({ archive }), 'dot_archive')
    await definition.execute({ dot: 'researcher' }, execution())
    expect(archive).toHaveBeenLastCalledWith({ dot: 'researcher' }, expect.anything())
    await definition.execute({ dot: 'researcher', stop_schedules: false }, execution())
    expect(archive).toHaveBeenLastCalledWith({ dot: 'researcher', stopSchedules: false }, expect.anything())
  })

  it('lists archived dots on request', async () => {
    const list = vi.fn(service().list)
    const definition = toolOf(service({ list }), 'dot_list')
    await definition.execute({ include_archived: true }, execution())
    expect(list).toHaveBeenCalledWith({ includeArchived: true }, expect.anything())
    await definition.execute({}, execution())
    expect(list).toHaveBeenLastCalledWith({}, expect.anything())
  })
})
