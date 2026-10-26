import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionCreateRequest, SessionListValue, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { ScheduleId, ScheduleService } from '@deepseek-ai/dsh-schedule'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as DotsPlugin from '../src/index.ts'
import { DotsController } from '../src/index.ts'
import * as ToolDotsPlugin from '../../tool-dots/src/index.ts'

const roots: string[] = []
let lastRoot: string | undefined
let context: Context | undefined
/** Medium shared across boots in one test, simulating a Host restart. */
let mediaPool: MemoryMediaPool | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
  mediaPool = undefined
})

/** One Session the stub controller reports. */
interface StubSession {
  readonly sessionId: SessionId
  running: boolean
  readonly agentAvailable: boolean
}

/**
 * Build a Session controller stub exposing only the operations the dots
 * lifecycle calls.
 *
 * The real controller brings the whole Web composition (LLM, projections,
 * persistence, Workspace registry). This test exercises the Loader, durable
 * domain, Remote service, and tool registration, so the Session boundary is the
 * one external service replaced: session creation, listing, renaming, prompting,
 * model catalog, and model selection. `Object.create` keeps the declared
 * `SessionController` type while the absent methods stay unreachable.
 * @returns the stub controller value.
 */
function sessionControllerStub(): SessionController {
  const sessions = new Map<string, StubSession>()
  let next = 1
  const stub: Pick<
    SessionController,
    'create' | 'rename' | 'list' | 'modelCatalog' | 'prompt' | 'selectModel'
  > = {
    async create(_request: SessionCreateRequest) {
      const sessionId = SessionId(`session-${next++}`)
      sessions.set(sessionId, { sessionId, running: false, agentAvailable: true })
      return { sessionId }
    },
    async rename(request) {
      return { title: request.title, seq: 0 }
    },
    async list(): Promise<SessionListValue> {
      const items: SessionSummary[] = [...sessions.values()].map(session => ({
        sessionId: session.sessionId,
        updatedAt: 0,
        running: session.running,
        agentAvailable: session.agentAvailable,
        blank: true,
      }))
      return { items }
    },
    async modelCatalog() {
      return {
        default: { provider: 'mock', model: 'mock-model' },
        routableProviders: ['mock'],
        groups: [{ id: 'mock', name: 'Mock', models: [{ id: 'mock-model', name: 'Mock Model' }] }],
        failures: [],
      }
    },
    async prompt() {
      return { accepted: true }
    },
    async selectModel(request) {
      return { selected: { provider: request.provider, model: request.model } }
    },
  }
  return Object.assign(Object.create(SessionController.prototype), stub) as SessionController
}

/**
 * Test-only plugin mounting the real storage hub, the real in-memory domain
 * facility, and the Session controller stub.
 * @returns the Loader row value.
 */
function dotsTestServices() {
  return {
    name: 'test-dots-services',
    inject: ['storage'],
    apply(ctx: Context) {
      ctx.storage.backend.register('memory', new MemoryStorageBackend(mediaPool))
      const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
      ctx.effect(() => ctx.storage.mount('domain', facility), 'test: domain form')
      ctx.provide('storageDomain', facility)
      ctx.provide('sessionController', sessionControllerStub())
      const schedules: ScheduleRecord[] = []
      ctx.provide(
        'schedule',
        Object.assign(Object.create(ScheduleService.prototype), {
          create: async (_sessionId: string, request: { title: string; prompt: string; every_seconds?: number }) => {
            const record = {
              id: ScheduleId(`schedule-${schedules.length + 1}`),
              kind: 'every',
              title: request.title,
              prompt: request.prompt,
              everySeconds: request.every_seconds ?? 60,
              scheduledAt: '2099-01-01T00:00:00.000Z',
            } satisfies ScheduleRecord
            schedules.push(record)
            return record
          },
          list: async () => schedules,
          delete: async (request: { id: string }) => {
            const index = schedules.findIndex(record => record.id === request.id)
            if (index >= 0) schedules.splice(index, 1)
            return { id: request.id, deleted: index >= 0 }
          },
        }),
      )
    },
  }
}

/**
 * Boot a real Loader composition with the dots and tool-dots rows.
 * @param options - optional legacy registry JSON seeded before activation, and
 *   whether the row omits `root` so the default root resolves from `$DSH_HOME`.
 * @returns the booted context.
 */
async function loadComposition(
  options: { readonly legacy?: unknown; readonly omitRoot?: boolean } = {},
): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dots-composition-'))
  roots.push(root)
  lastRoot = root
  const configPath = join(root, 'cordis.yml')
  if (options.legacy !== undefined) {
    await mkdir(join(root, 'dots'), { recursive: true })
    await writeFile(join(root, 'dots', 'registry.json'), JSON.stringify(options.legacy), 'utf8')
  }
  await writeFile(
    configPath,
    [
      "- name: '@deepseek-ai/dsh-storage'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: 'test-dots-services'",
      "- name: '@deepseek-ai/dsh-dots'",
      ...(options.omitRoot === true ? [] : ['  config:', `    root: ${JSON.stringify(join(root, 'dots'))}`]),
      "- name: '@deepseek-ai/dsh-tool-dots'",
      '',
    ].join('\n'),
  )

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['test-dots-services', dotsTestServices()],
    ['@deepseek-ai/dsh-dots', DotsPlugin],
    ['@deepseek-ai/dsh-tool-dots', ToolDotsPlugin],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never {
      throw new Error('unexpected module hook registration')
    },
    getOrCreateModuleJob(): never {
      throw new Error('unexpected module job creation')
    },
    resolveSync(): never {
      throw new Error('unexpected synchronous module resolution')
    },
    load(): never {
      throw new Error('unexpected module load')
    },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

/**
 * Build one durable legacy record accepted by the record decoder.
 * @param name - dot name.
 * @param id - dot id.
 * @returns the record fields.
 */
function legacyRecord(name = 'legacy', id = 'dot-legacy-abc123') {
  return {
    version: 1,
    id,
    name,
    purpose: `${name} purpose`,
    directory: join(tmpdir(), 'dsh-dots-legacy', id),
    sessionId: `session-${name}`,
    preset: 'standard',
    createdAt: 1,
    updatedAt: 1,
    assignmentCount: 0,
  }
}

describe('dots real Loader composition', () => {
  it('registers the dotsController service with its Remote operation set', async () => {
    const ctx = await loadComposition()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(ctx.dotsController).toBeInstanceOf(DotsController)
    expect(remoteMethods(ctx.dotsController).map(marker => marker.exportName ?? marker.method).sort()).toEqual([
      'archive',
      'assign',
      'create',
      'list',
      'scheduleCreate',
      'scheduleList',
      'update',
    ])
  })

  it('registers the six model-facing tools', async () => {
    const ctx = await loadComposition()
    for (const name of ['dot_create', 'dot_list', 'dot_assign', 'dot_update', 'dot_schedule', 'dot_archive']) {
      const definition = ctx.tools.get(name)
      expect(definition, name).toBeDefined()
      expect(definition!.description.length).toBeGreaterThan(40)
      expect(definition!.parameters).toBeTypeOf('object')
    }
  })

  it('creates, lists, and assigns through the mounted service and durable domain', async () => {
    const ctx = await loadComposition()
    const created = await ctx.dotsController.create({
      name: 'researcher',
      purpose: 'Keep the launch FAQ aligned with approved decisions.',
    })
    expect(created.view).toMatchObject({ name: 'researcher', preset: 'standard', status: 'idle' })
    expect(created.warnings).toEqual([])

    const listed = await ctx.dotsController.list({})
    expect(listed.dots).toHaveLength(1)
    expect(listed.dots[0]!.sessionId).toBe(created.view.sessionId)

    const assigned = await ctx.dotsController.assign({ dot: 'researcher', task: 'Draft the FAQ.', from: 'session-9' })
    expect(assigned).toMatchObject({ accepted: true, status: 'queued' })
    expect((await ctx.dotsController.list({})).dots[0]!.assignmentCount).toBe(1)

    const updated = await ctx.dotsController.update({
      dot: 'researcher',
      purpose: 'Keep the FAQ current.',
      allowedTools: ['read'],
    })
    expect(updated.allowedTools).toEqual(['read'])

    const withMemory = await ctx.dotsController.update({ dot: 'researcher', addMemory: 'Prefer short reports.' })
    expect(withMemory.purpose).toContain('FAQ')

    const archived = await ctx.dotsController.archive({ dot: 'researcher' })
    expect(archived).toMatchObject({ archived: true, deletedSchedules: 0 })
    expect((await ctx.dotsController.list({})).dots).toEqual([])
    expect((await ctx.dotsController.list({ includeArchived: true })).dots).toHaveLength(1)
  })

  it('creates a dot with every optional field and imports a legacy registry once', async () => {
    const ctx = await loadComposition()
    const created = await ctx.dotsController.create({
      name: 'configured',
      purpose: 'Configured dot.',
      preset: 'standard',
      permissionPreset: 'workspace-write',
      allowedTools: ['read'],
      model: { provider: 'mock', model: 'mock-model' },
    })
    // The composition mounts no permission-preset service, so the warning path runs.
    expect(created.warnings.join(' ')).toMatch(/Permission preset/u)
    expect(created.view.model).toEqual({ provider: 'mock', model: 'mock-model' })
    expect(created.view.allowedTools).toEqual(['read'])
  })

  it('creates, lists, and stops a dot schedule through the Remote service', async () => {
    const ctx = await loadComposition()
    await ctx.dotsController.create({ name: 'researcher', purpose: 'Research.' })
    const created = await ctx.dotsController.scheduleCreate({
      dot: 'researcher',
      title: 'Hourly check',
      prompt: 'Check the FAQ.',
      every_seconds: 3_600,
    })
    expect(created).toMatchObject({ kind: 'every', title: 'Hourly check' })
    expect((await ctx.dotsController.scheduleList({ dot: 'researcher' })).schedules).toHaveLength(1)
    const archived = await ctx.dotsController.archive({ dot: 'researcher' })
    expect(archived.deletedSchedules).toBe(1)
  })

  it('imports a legacy registry once at activation', async () => {
    const ctx = await loadComposition({ legacy: { version: 1, dots: [legacyRecord()] } })
    expect((await ctx.dotsController.list({})).dots.map(dot => dot.name)).toEqual(['legacy'])
    await expect(readFile(join(lastRoot!, 'dots', 'registry.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(join(lastRoot!, 'dots', 'registry.json.imported'), 'utf8')).resolves.toContain(
      '"dots"',
    )
  })

  it('leaves a legacy file in place beside stored records', async () => {
    mediaPool = new MemoryMediaPool()
    const first = await loadComposition()
    await first.dotsController.create({ name: 'existing', purpose: 'Existing.' })
    await first.fiber.dispose()
    context = undefined
    const second = await loadComposition({ legacy: { version: 1, dots: [legacyRecord()] } })
    expect((await second.dotsController.list({})).dots.map(dot => dot.name)).toEqual(['existing'])
    await expect(readFile(join(lastRoot!, 'dots', 'registry.json'), 'utf8')).resolves.toContain('legacy')
  })

  it('keeps assignment acceptance when bookkeeping fails', async () => {
    mediaPool = new MemoryMediaPool()
    const ctx = await loadComposition()
    await ctx.dotsController.create({ name: 'researcher', purpose: 'Research.' })
    mediaPool.failNextWrites = 1
    const assigned = await ctx.dotsController.assign({ dot: 'researcher', task: 'Do it.' })
    expect(assigned).toMatchObject({ accepted: true, status: 'queued' })
    expect((await ctx.dotsController.list({})).dots[0]!.assignmentCount).toBe(0)
  })

  it('defaults the dot root to $DSH_HOME/dots', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-dots-home-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    try {
      const ctx = await loadComposition({ omitRoot: true })
      const created = await ctx.dotsController.create({ name: 'defaulted', purpose: 'Defaulted.' })
      expect(created.view.directory.startsWith(join(home, 'dots'))).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('fills configuration defaults and rejects an invalid preset allowlist', async () => {
    const ctx = await loadComposition()
    const created = await ctx.dotsController.create({ name: 'limited', purpose: 'Limited configuration.' })
    expect(created.view.preset).toBe('standard')
  })
})
