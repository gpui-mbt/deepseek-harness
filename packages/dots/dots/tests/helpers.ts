/**
 * Shared fixtures for the dots suite: a real in-memory storage domain, a
 * structural Host fake, and deterministic configuration.
 * @module tests/helpers
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import type { Config } from '../src/config.ts'
import { dotsDomain } from '../src/storage.ts'
import type {
  DotsAgent,
  DotsHost,
  DotModelCatalog,
  DotModelSelection,
  DotSessionSummary,
  ScheduleCreateRequest,
  ScheduleRecordLike,
} from '../src/types.ts'

/** One live fake agent. */
export class FakeAgent implements DotsAgent {
  status: 'idle' | 'running' = 'idle'
  cancelled = false
  failCancel = false
  cancelCause: { readonly kind: 'user' } | undefined

  constructor(readonly id: string) {}

  cancel(cause: { readonly kind: 'user' }): void {
    if (this.failCancel) throw new Error('cancel unavailable')
    this.cancelled = true
    this.cancelCause = cause
    this.status = 'idle'
  }
}

/** Structural Host fake used by the controller and guard suites. */
export class FakeHost implements DotsHost {
  readonly live = new Map<string, FakeAgent>()
  /** Persisted Session rows: identity to running/agentAvailable facts. */
  readonly sessions = new Map<string, { running: boolean; agentAvailable: boolean }>()
  readonly parents = new Map<string, readonly string[]>()
  readonly prompts: Array<{ readonly sessionId: string; readonly text: string; readonly assignmentId: string }> = []
  readonly workspaces: Array<{ readonly directory: string; readonly title: string; readonly id: string }> = []
  readonly schedules = new Map<string, ScheduleRecordLike[]>()
  readonly permissions: Array<{ readonly sessionId: string; readonly name: string }> = []
  readonly renames: Array<{ readonly sessionId: string; readonly title: string }> = []
  readonly modelSelections: Array<{ readonly sessionId: string; readonly selection: DotModelSelection }> = []
  modelCatalog: DotModelCatalog = {
    default: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    groups: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          {
            id: 'deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            efforts: [
              { id: 'high', name: 'High' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'high',
          },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        ],
      },
    ],
    failures: [],
  }
  nowValue = 1_700_000_000_000
  failWorkspace = false
  failSession = false
  failCatalog = false
  failRename = false
  failModel = false
  private next = 1

  async createWorkspace(directory: string, title: string): Promise<{ readonly id: string }> {
    if (this.failWorkspace) throw new Error('workspace unavailable')
    const workspace = { directory, title, id: `ws-${this.next++}` }
    this.workspaces.push(workspace)
    return { id: workspace.id }
  }

  async createSession(_input: {
    readonly directory: string
    readonly workspaceId?: string
    readonly preset: string
  }): Promise<{ readonly sessionId: string }> {
    if (this.failSession) throw new Error('session unavailable')
    const sessionId = `sess-${this.next++}`
    this.sessions.set(sessionId, { running: false, agentAvailable: true })
    this.live.set(sessionId, new FakeAgent(sessionId))
    return { sessionId }
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    if (this.failRename) throw new Error('rename unavailable')
    this.renames.push({ sessionId, title })
  }

  async listSessions(_signal?: AbortSignal): Promise<readonly DotSessionSummary[]> {
    return [...this.sessions.entries()].map(([sessionId, facts]) => ({
      sessionId,
      running: facts.running,
      agentAvailable: facts.agentAvailable,
    }))
  }

  getAgent(sessionId: string): DotsAgent | undefined {
    return this.live.get(sessionId)
  }

  parentSessions(sessionId: string): readonly string[] {
    return this.parents.get(sessionId) ?? []
  }

  async setPermissionPreset(sessionId: string, name: string): Promise<void> {
    this.permissions.push({ sessionId, name })
  }

  async listModels(): Promise<DotModelCatalog> {
    if (this.failCatalog) throw new Error('catalog unavailable')
    return this.modelCatalog
  }

  async selectModel(sessionId: string, selection: DotModelSelection): Promise<void> {
    if (this.failModel) throw new Error('model unavailable')
    this.modelSelections.push({ sessionId, selection })
  }

  async prompt(sessionId: string, text: string, assignmentId: string): Promise<void> {
    const facts = this.sessions.get(sessionId)
    if (facts === undefined) throw new Error(`unknown session ${sessionId}`)
    this.prompts.push({ sessionId, text, assignmentId })
    facts.agentAvailable = true
    this.live.set(sessionId, this.live.get(sessionId) ?? new FakeAgent(sessionId))
  }

  async createSchedule(
    sessionId: string,
    request: ScheduleCreateRequest,
  ): Promise<ScheduleRecordLike> {
    const record: ScheduleRecordLike = {
      id: `sch-${this.next++}`,
      kind: request.cron === undefined ? 'after' : 'cron',
      title: request.title,
      scheduledAt: '2099-01-01T00:00:00.000Z',
    }
    const current = this.schedules.get(sessionId) ?? []
    this.schedules.set(sessionId, [...current, record])
    return record
  }

  async listSchedules(sessionId: string): Promise<readonly ScheduleRecordLike[]> {
    return this.schedules.get(sessionId) ?? []
  }

  async deleteSchedule(sessionId: string, id: string): Promise<void> {
    this.schedules.set(
      sessionId,
      (this.schedules.get(sessionId) ?? []).filter(record => record.id !== id),
    )
  }

  now(): number {
    return this.nowValue
  }

  /** Mark a session cold: the live agent disappears but its row remains. */
  cold(sessionId: string): void {
    this.live.delete(sessionId)
    const facts = this.sessions.get(sessionId)
    if (facts !== undefined) facts.agentAvailable = false
  }
}

/** Complete test configuration. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    defaultPreset: 'standard',
    maxDots: 4,
    maxTaskBytes: 10_000,
    maxPurposeBytes: 4_000,
    maxMemoryBytes: 8_192,
    enforceToolAllowlist: true,
    ...overrides,
  }
}

/** One isolated temporary dot root. */
export interface TempRoot {
  readonly root: string
  readonly cleanup: () => Promise<void>
}

/**
 * Create a temporary dot root under the OS temporary directory.
 * @returns root and cleanup.
 */
export async function tempRoot(): Promise<TempRoot> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dots-'))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** One open in-memory dots domain and its teardown. */
export interface MemoryDomain {
  readonly domain: Domain<typeof dotsDomain>
  readonly pool: MemoryMediaPool
  readonly close: () => Promise<void>
}

/**
 * Open the real `dots` domain over the in-memory storage backend.
 * @returns the open domain and a teardown that closes both domain and context.
 */
export async function memoryDomain(): Promise<MemoryDomain> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(dotsDomain)
  return {
    domain,
    pool,
    close: async () => {
      await domain.close()
      await ctx.fiber.dispose()
    },
  }
}
