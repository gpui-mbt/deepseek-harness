import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { validatePresetAllowlists } from '../src/config.ts'
import { DotError, asDotError } from '../src/errors.ts'
import { normalizeAllowedTools } from '../src/paths.ts'
import type { Config } from '../src/config.ts'
import { DotController } from '../src/controller.ts'
import { dotPaths } from '../src/paths.ts'
import { DotStore } from '../src/store.ts'
import { FakeHost, memoryDomain, tempRoot, testConfig } from './helpers.ts'
import type { TempRoot } from './helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

interface Fixture {
  readonly root: string
  readonly host: FakeHost
  readonly controller: DotController
  readonly config: Config
  readonly warnings: string[]
}

async function setup(overrides: Partial<Config> = {}, host = new FakeHost()): Promise<Fixture> {
  const temp: TempRoot = await tempRoot()
  cleanups.push(temp.cleanup)
  const memory = await memoryDomain()
  cleanups.push(memory.close)
  const config = testConfig(overrides)
  const warnings: string[] = []
  const controller = new DotController(config, host, new DotStore(memory.domain), temp.root, message => warnings.push(message))
  return { root: temp.root, host, controller, config, warnings }
}

async function createOne(fixture: Fixture, name = 'researcher') {
  return await fixture.controller.create({
    name,
    purpose: 'Keep the launch FAQ aligned with approved decisions.',
  })
}

describe('DotController lifecycle', () => {
  it('creates a workspace, home session, contract, and memory', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    expect(created.view).toMatchObject({
      name: 'researcher',
      preset: 'standard',
      status: 'idle',
      assignmentCount: 0,
    })
    const paths = dotPaths(fixture.root, created.view.id)
    expect(await readFile(paths.contract, 'utf8')).toContain('Keep the launch FAQ')
    expect(await readFile(paths.memory, 'utf8')).toContain('# Dot memory')
    expect(await readFile(paths.manifest, 'utf8')).toContain(created.view.id)
    expect(fixture.host.workspaces).toHaveLength(1)
    expect(fixture.host.renames).toEqual([{ sessionId: created.view.sessionId, title: 'researcher' }])
    expect(await fixture.controller.list()).toHaveLength(1)
  })

  it('selects and stores a model on the home session', async () => {
    const fixture = await setup()
    const created = await fixture.controller.create({
      name: 'modeled',
      purpose: 'Use a specific model.',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    })
    expect(created.view.model).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    })
    expect(fixture.host.modelSelections).toEqual([
      {
        sessionId: created.view.sessionId,
        selection: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
      },
    ])
  })

  it('rejects an unavailable model before creating the dot', async () => {
    const fixture = await setup()
    await expect(
      fixture.controller.create({
        name: 'bad-model',
        purpose: 'Bad model.',
        model: { provider: 'deepseek', model: 'missing' },
      }),
    ).rejects.toMatchObject({ code: 'dots/invalid' })
    expect(await readdir(fixture.root)).toEqual([])
    expect(fixture.host.live.size).toBe(0)
  })

  it('quarantines a Session when its requested permission preset fails', async () => {
    const fixture = await setup({ enforceToolAllowlist: false })
    vi.spyOn(fixture.host, 'setPermissionPreset').mockRejectedValue(new Error('preset unavailable'))
    await expect(fixture.controller.create({ name: 'restricted', purpose: 'Research.', permissionPreset: 'read-only' })).rejects.toThrow(
      'quarantined',
    )
    expect(await fixture.controller.list()).toEqual([])
    const [quarantined] = await fixture.controller.list(true)
    expect(quarantined).toBeDefined()
    expect(quarantined).not.toHaveProperty('permissionPreset')
    expect(fixture.host.live.get(quarantined!.sessionId)?.cancelled).toBe(true)
    fixture.host.parents.set('child', [quarantined!.sessionId])
    for (const sessionId of [quarantined!.sessionId, 'child']) {
      expect(fixture.controller.guardDenial(sessionId, 'write')).toBeDefined()
    }
    await expect(fixture.controller.assign({ ref: 'restricted', task: 'do work' })).rejects.toMatchObject({ code: 'dots/not-found' })
    expect(fixture.host.prompts).toEqual([])
  })

  it('applies a permission preset to the home session', async () => {
    const fixture = await setup()
    const created = await fixture.controller.create({
      name: 'watcher',
      purpose: 'Watch.',
      permissionPreset: 'workspace-write',
    })
    expect(created.warnings).toEqual([])
    expect(fixture.host.permissions).toEqual([{ sessionId: created.view.sessionId, name: 'workspace-write' }])
  })

  it('falls back to the dot directory when workspace registration fails', async () => {
    const fixture = await setup()
    fixture.host.failWorkspace = true
    const created = await createOne(fixture)
    expect(created.warnings.join(' ')).toMatch(/Workspace registration failed/u)
    expect(created.view.workspaceId).toBeUndefined()
    expect(created.view.sessionId).toMatch(/^sess-/u)
  })

  it('cleans up when session creation fails before a workspace exists', async () => {
    const fixture = await setup()
    fixture.host.failWorkspace = true
    fixture.host.failSession = true
    await expect(createOne(fixture)).rejects.toMatchObject({ code: 'dots/internal' })
    expect(await readdir(fixture.root)).toEqual([])
  })

  it('rejects duplicate names and the active cap', async () => {
    const fixture = await setup({ maxDots: 1 })
    await createOne(fixture)
    await expect(createOne(fixture)).rejects.toMatchObject({ code: 'dots/conflict' })
    await expect(fixture.controller.create({ name: 'other', purpose: 'Other.' })).rejects.toMatchObject({ code: 'dots/limit' })
  })

  it('reports model validation failures and a failed catalog read', async () => {
    const fixture = await setup()
    await expect(
      fixture.controller.create({
        name: 'blank-model',
        purpose: 'Blank.',
        model: { provider: ' ', model: 'flash' },
      }),
    ).rejects.toMatchObject({ code: 'dots/invalid' })
    await expect(
      fixture.controller.create({
        name: 'bad-effort',
        purpose: 'Effort.',
        model: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
      }),
    ).rejects.toMatchObject({ code: 'dots/invalid' })
    fixture.host.failCatalog = true
    await expect(
      fixture.controller.create({
        name: 'catalog-down',
        purpose: 'Catalog.',
        model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      }),
    ).rejects.toMatchObject({ code: 'dots/unavailable' })
  })

  it('reports a failed turn cancellation while archiving', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    fixture.host.live.get(created.view.sessionId)!.failCancel = true
    const result = await fixture.controller.archive(created.view.id)
    expect(result.warnings?.join(' ')).toMatch(/Could not cancel the live turn/u)
    expect(result.archived).toBe(true)
  })

  it('reports a failed schedule listing while archiving', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    fixture.host.listSchedules = async () => {
      throw new Error('schedule store unavailable')
    }
    const result = await fixture.controller.archive(created.view.id)
    expect(result.warnings?.join(' ')).toMatch(/Could not list schedules/u)
  })

  it('reports rename and model failures as warnings', async () => {
    const fixture = await setup()
    fixture.host.failRename = true
    fixture.host.failModel = true
    const created = await fixture.controller.create({
      name: 'warned',
      purpose: 'Warnings.',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    })
    expect(created.warnings.join(' ')).toMatch(/could not be renamed/u)
    expect(created.warnings.join(' ')).toMatch(/could not be selected/u)
    expect(created.view.model).toBeUndefined()
  })

  it('keeps the dot directory when session creation fails after a workspace', async () => {
    const fixture = await setup()
    fixture.host.failSession = true
    await expect(createOne(fixture)).rejects.toThrow(/The dot directory is/u)
    expect(await fixture.controller.list()).toEqual([])
  })

  it('reports a failed record write after creation', async () => {
    const temp: TempRoot = await tempRoot()
    cleanups.push(temp.cleanup)
    const memory = await memoryDomain()
    cleanups.push(memory.close)
    const host = new FakeHost()
    const controller = new DotController(testConfig(), host, new DotStore(memory.domain), temp.root, () => undefined)
    memory.pool.failNextWrites = 1
    await expect(controller.create({ name: 'unwritten', purpose: 'Unwritten.' })).rejects.toThrow(/The created directory is/u)
  })

  it('rejects a blank preset, blank memory notes, and oversized notes', async () => {
    const fixture = await setup({ maxTaskBytes: 10 })
    await expect(fixture.controller.create({ name: 'blank', purpose: 'Blank.', preset: '   ' })).rejects.toMatchObject({
      code: 'dots/invalid',
    })
    const created = await createOne(fixture)
    await expect(fixture.controller.update(created.view.id, { addMemory: '   ' })).rejects.toMatchObject({
      code: 'dots/invalid',
    })
    await expect(fixture.controller.update(created.view.id, { addMemory: 'x'.repeat(20) })).rejects.toMatchObject({ code: 'dots/invalid' })
  })

  it('recreates the memory file and injects an empty excerpt when it is missing', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    const paths = dotPaths(fixture.root, created.view.id)
    await rm(paths.memory)
    await fixture.controller.update(created.view.id, { addMemory: 'Remember this.' })
    expect(await readFile(paths.memory, 'utf8')).toContain('Remember this.')
    await rm(paths.memory)
    await fixture.controller.assign({ ref: created.view.id, task: 'Work.' })
    expect(fixture.host.prompts[0]!.text).toContain('## Durable memory\nnone')
  })

  it('rejects a blank schedule prompt and reports a schedule deletion failure', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    await expect(fixture.controller.schedule(created.view.id, { title: 'Blank', prompt: '   ', every_seconds: 60 })).rejects.toMatchObject({
      code: 'dots/invalid',
    })
    await fixture.controller.schedule(created.view.id, {
      title: 'Check',
      prompt: 'Check.',
      every_seconds: 60,
    })
    fixture.host.deleteSchedule = async () => {
      throw new Error('delete unavailable')
    }
    const archived = await fixture.controller.archive(created.view.id)
    expect(archived.warnings?.join(' ')).toMatch(/Could not delete schedule/u)
  })

  it('enforces configured preset allowlists', async () => {
    const fixture = await setup({ allowedPresets: ['standard'], allowedPermissionPresets: ['workspace-write'] })
    await expect(fixture.controller.create({ name: 'other', purpose: 'Other.', preset: 'creator' })).rejects.toThrow(/not allowed/u)
    await expect(fixture.controller.create({ name: 'other', purpose: 'Other.', permissionPreset: 'auto' })).rejects.toThrow(/not allowed/u)
    const created = await createOne(fixture)
    expect(created.view.preset).toBe('standard')
  })

  it('rejects allowlists that exclude their own default at load', () => {
    expect(() => {
      validatePresetAllowlists(testConfig({ allowedPresets: ['creator'] }))
    }).toThrow(/defaultPreset/u)
    expect(() => {
      validatePresetAllowlists(testConfig({ defaultPermissionPreset: 'auto', allowedPermissionPresets: ['workspace-write'] }))
    }).toThrow(/defaultPermissionPreset/u)
    expect(() => {
      validatePresetAllowlists(testConfig({ defaultPreset: 'standard', allowedPresets: ['standard'] }))
    }).not.toThrow()
    expect(() => {
      validatePresetAllowlists(testConfig({ defaultPreset: '   ' }))
    }).toThrow(/must not be blank/u)
  })

  it('normalizes errors and allowlist sizes', () => {
    expect(asDotError(new DotError('dots/x', 'message')).code).toBe('dots/x')
    expect(asDotError('boom')).toMatchObject({ code: 'dots/internal', message: 'boom' })
    expect(asDotError(new Error('failed'), 'dots/fallback')).toMatchObject({
      code: 'dots/fallback',
      message: 'failed',
    })
    expect(() => normalizeAllowedTools(Array.from({ length: 65 }, (_, index) => `tool-${index}`))).toThrow(/At most 64/u)
    expect(normalizeAllowedTools(['read', 'read', 'write'])).toEqual(['read', 'write'])
  })

  it('assigns work with bounded memory and records the assignment', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    await fixture.controller.update(created.view.id, { addMemory: 'The user prefers short reports.' })
    const result = await fixture.controller.assign({ ref: created.view.id, task: 'Draft the FAQ.', from: 'main' })
    expect(result).toMatchObject({ accepted: true, status: 'queued' })
    const prompt = fixture.host.prompts[0]!
    expect(prompt.sessionId).toBe(created.view.sessionId)
    expect(prompt.text).toContain('[DOT ASSIGNMENT]')
    expect(prompt.text).toContain(`Dot id: ${created.view.id}`)
    expect(prompt.text).toContain('The user prefers short reports.')
    expect(prompt.text).toContain('Draft the FAQ.')
    expect(prompt.text).toContain('From: main')
    expect((await fixture.controller.list())[0]!.assignmentCount).toBe(1)
  })

  it('reports a cold session as asleep and an absent session as missing', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    fixture.host.cold(created.view.sessionId)
    expect((await fixture.controller.list())[0]!.status).toBe('asleep')
    fixture.host.sessions.delete(created.view.sessionId)
    expect((await fixture.controller.list())[0]!.status).toBe('missing')
    await expect(fixture.controller.assign({ ref: created.view.id, task: 'work' })).rejects.toMatchObject({
      code: 'dots/session-missing',
    })
  })

  it('reports a running turn', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    fixture.host.sessions.get(created.view.sessionId)!.running = true
    expect((await fixture.controller.list())[0]!.status).toBe('running')
  })

  it('refuses blank, oversized, missing, and archived assignments', async () => {
    const fixture = await setup({ maxTaskBytes: 20 })
    const created = await createOne(fixture)
    await expect(fixture.controller.assign({ ref: created.view.id, task: '   ' })).rejects.toMatchObject({
      code: 'dots/invalid',
    })
    await expect(fixture.controller.assign({ ref: created.view.id, task: 'x'.repeat(21) })).rejects.toMatchObject({
      code: 'dots/invalid',
    })
    await expect(fixture.controller.assign({ ref: 'missing', task: 'x' })).rejects.toMatchObject({
      code: 'dots/not-found',
    })
    await fixture.controller.archive(created.view.id)
    await expect(fixture.controller.assign({ ref: created.view.id, task: 'x' })).rejects.toMatchObject({
      code: 'dots/not-found',
    })
  })

  it('updates purpose, allowlist, and memory', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    const updated = await fixture.controller.update(created.view.id, {
      purpose: 'Keep the FAQ current and cite sources.',
      allowedTools: ['read', 'web_search'],
      addMemory: 'Use the approved brief.',
    })
    expect(updated.purpose).toContain('cite sources')
    expect(updated.allowedTools).toEqual(['read', 'web_search'])
    const paths = dotPaths(fixture.root, created.view.id)
    expect(await readFile(paths.contract, 'utf8')).toContain('cite sources')
    expect(await readFile(paths.memory, 'utf8')).toContain('Use the approved brief.')
    await expect(fixture.controller.update(created.view.id, {})).rejects.toMatchObject({ code: 'dots/invalid' })
  })

  it('creates a framed schedule and refuses ambiguous selectors', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    const scheduled = await fixture.controller.schedule(created.view.id, {
      title: 'Daily check',
      prompt: 'Check the FAQ.',
      every_seconds: 3_600,
    })
    expect(scheduled).toMatchObject({ kind: 'after', title: 'Daily check' })
    const record = fixture.host.schedules.get(created.view.sessionId)?.[0]
    expect(record).toBeDefined()
    expect((await fixture.controller.scheduleList(created.view.id)).length).toBe(1)
    await expect(
      fixture.controller.schedule(created.view.id, {
        title: 'Bad',
        prompt: 'x',
        every_seconds: 60,
        cron: { expression: '* * * * *', time_zone: 'UTC' },
      }),
    ).rejects.toMatchObject({ code: 'dots/invalid' })
    await expect(fixture.controller.schedule(created.view.id, { title: '', prompt: 'x', every_seconds: 60 })).rejects.toMatchObject({
      code: 'dots/invalid',
    })
  })

  it('archives by stopping schedules and cancelling the live turn', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    await fixture.controller.schedule(created.view.id, {
      title: 'Check',
      prompt: 'Check.',
      every_seconds: 60,
    })
    const agent = fixture.host.live.get(created.view.sessionId)!
    agent.status = 'running'
    const result = await fixture.controller.archive(created.view.id)
    expect(result).toMatchObject({ archived: true, deletedSchedules: 1 })
    expect(agent.cancelled).toBe(true)
    expect(agent.cancelCause).toEqual({ kind: 'user' })
    expect(fixture.host.schedules.get(created.view.sessionId)).toEqual([])
    expect(await fixture.controller.list()).toEqual([])
    expect(await fixture.controller.list(true)).toHaveLength(1)
  })

  it('denies management tools to dots and enforces tool allowlists', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    expect(fixture.controller.guardDenial(created.view.sessionId, 'dot_create')).toMatch(/cannot create/u)
    expect(fixture.controller.guardDenial(created.view.sessionId, 'read')).toBeUndefined()
    await fixture.controller.update(created.view.id, { allowedTools: ['read', 'mcp__github__*'] })
    expect(fixture.controller.guardDenial(created.view.sessionId, 'read')).toBeUndefined()
    expect(fixture.controller.guardDenial(created.view.sessionId, 'mcp__github__issue')).toBeUndefined()
    expect(fixture.controller.guardDenial(created.view.sessionId, 'write')).toMatch(/not allowed/u)
    expect(fixture.controller.guardDenial('other-session', 'write')).toBeUndefined()
  })

  it('applies a dot policy to sessions in its live subagent lineage', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    await fixture.controller.update(created.view.id, { allowedTools: ['read'] })
    fixture.host.parents.set('child-session', [created.view.sessionId])
    expect(fixture.controller.guardDenial('child-session', 'dot_create')).toMatch(/cannot create/u)
    expect(fixture.controller.guardDenial('child-session', 'write')).toMatch(/not allowed/u)
    expect(fixture.controller.guardDenial('child-session', 'read')).toBeUndefined()
  })

  it('renders a permission preset without an allowlist and appends without a trailing newline', async () => {
    const fixture = await setup()
    const created = await fixture.controller.create({
      name: 'watcher',
      purpose: 'Watch.',
      permissionPreset: 'workspace-write',
    })
    const paths = dotPaths(fixture.root, created.view.id)
    await writeFile(paths.memory, '# Memory without a trailing newline', 'utf8')
    await fixture.controller.update(created.view.id, { purpose: 'Watch closely.' })
    expect(await readFile(paths.contract, 'utf8')).toContain('`workspace-write`')
    await fixture.controller.update(created.view.id, { addMemory: 'First note.' })
    const memory = await readFile(paths.memory, 'utf8')
    expect(memory).toContain('\n- ')
    expect(memory).toContain('First note.')
  })

  it('archives without stopping schedules and reports an empty allowlist', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    await fixture.controller.schedule(created.view.id, {
      title: 'Check',
      prompt: 'Check.',
      every_seconds: 60,
    })
    const archived = await fixture.controller.archive(created.view.id, false)
    expect(archived.deletedSchedules).toBe(0)
    expect(fixture.host.schedules.get(created.view.sessionId)).toHaveLength(1)

    const second = await createOne(fixture, 'empty-allowlist')
    await fixture.controller.update(second.view.id, { allowedTools: [] })
    expect(fixture.controller.guardDenial(second.view.sessionId, 'read')).toContain('(none)')
  })

  it('finds a dot through a deeper live ancestor', async () => {
    const fixture = await setup()
    const created = await createOne(fixture)
    fixture.host.parents.set('grandchild', ['plain-session', created.view.sessionId])
    expect(fixture.controller.guardDenial('grandchild', 'dot_create')).toMatch(/cannot create/u)
  })

  it('honors enforceToolAllowlist=false', async () => {
    const fixture = await setup({ enforceToolAllowlist: false })
    const created = await createOne(fixture)
    await fixture.controller.update(created.view.id, { allowedTools: ['read'] })
    expect(fixture.controller.guardDenial(created.view.sessionId, 'write')).toBeUndefined()
  })
})
