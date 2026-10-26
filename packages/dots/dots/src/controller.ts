/**
 * Local dot lifecycle: create, list, assign, update, schedule, archive, and
 * execution-time tool policy.
 *
 * The controller owns every business rule that does not need a Cordis context:
 * name/purpose/allowlist validation, the assignment frame, the scheduled-task
 * frame, and the execution guard. Session, Workspace, permission, and schedule
 * effects reach it only through {@link DotsHost}.
 * @module @deepseek-ai/dsh-dots/controller
 */

import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { requireAllowedPermissionPreset, requireAllowedPreset } from './config.ts'
import type { Config } from './config.ts'
import { DotError, asDotError } from './errors.ts'
import {
  dotPaths,
  makeDotId,
  memoryEntry,
  memoryExcerpt,
  normalizeAllowedTools,
  normalizeName,
  normalizePurpose,
  renderContract,
  renderManifest,
  renderMemory,
} from './paths.ts'
import type { DotStore } from './store.ts'
import type {
  ArchiveResult,
  AssignResult,
  CreateDotInput,
  DotModelCatalog,
  DotModelSelection,
  DotRecord,
  DotSessionSummary,
  DotStatus,
  DotView,
  DotsHost,
  ScheduleCreateRequest,
  ScheduleRecordLike,
  ScheduleResult,
  UpdateDotInput,
} from './types.ts'

/** Description of the created dot returned to the caller. */
export interface CreatedDot {
  /** The created dot with live status. */
  readonly view: DotView
  /** Non-fatal failures observed while creating the dot. */
  readonly warnings: readonly string[]
}

/** Inputs to one local assignment. */
export interface AssignInput {
  /** Dot id or case-insensitive name. */
  readonly ref: string
  /** Task text, bounded by `maxTaskBytes`. */
  readonly task: string
  /** Caller identity recorded in the assignment frame. */
  readonly from?: string
}

/** One lifecycle controller over the durable store and the Host ports. */
export class DotController {
  /**
   * @param config - validated deployment configuration.
   * @param host - Host service adapter.
   * @param store - durable dot record set.
   * @param root - absolute dot root.
   * @param warn - diagnostic sink for failures that must not fail the caller.
   */
  constructor(
    private readonly config: Config,
    private readonly host: DotsHost,
    private readonly store: DotStore,
    private readonly root: string,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * Create one dot, its workspace directory, and its home session.
   * @param input - name, purpose, and optional preset/permissions/model.
   * @param signal - optional caller cancellation before the first effect.
   * @returns the created view and non-fatal warnings.
   * @throws DotError for invalid input, a duplicate name, the active cap, or a
   *   failed creation whose dot directory could not be removed.
   */
  async create(input: CreateDotInput, signal?: AbortSignal): Promise<CreatedDot> {
    const name = normalizeName(input.name)
    const purpose = normalizePurpose(input.purpose, this.config.maxPurposeBytes)
    const requestedPreset = (input.preset ?? this.config.defaultPreset).trim()
    if (requestedPreset.length === 0) throw new DotError('dots/invalid', 'Agent preset must not be blank.')
    const preset = requireAllowedPreset(this.config, requestedPreset)
    const permissionPreset = requireAllowedPermissionPreset(
      this.config,
      input.permissionPreset ?? this.config.defaultPermissionPreset,
    )
    const allowedTools = normalizeAllowedTools(input.allowedTools)
    if (input.model !== undefined) await this.validateModel(input.model)
    signal?.throwIfAborted()
    const active = this.store.list(false)
    if (active.some(record => record.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new DotError('dots/conflict', `A dot named "${name}" already exists.`)
    }
    if (active.length >= this.config.maxDots) {
      throw new DotError('dots/limit', `The dot limit (${this.config.maxDots}) has been reached.`)
    }

    const id = makeDotId(name)
    const paths = dotPaths(this.root, id)
    const now = this.host.now()
    const warnings: string[] = []
    let workspaceCreated = false
    let sessionId = ''
    let workspaceId: string | undefined
    let appliedModel: DotModelSelection | undefined

    await mkdir(this.root, { recursive: true, mode: 0o700 })
    try {
      await mkdir(paths.directory, { mode: 0o700 })
    } catch (error: unknown) {
      /* v8 ignore start -- the id is freshly minted per call, so a collision or an unwritable root needs an OS-level fault no spec can induce portably. */
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new DotError('dots/conflict', `Dot directory already exists: ${paths.directory}`)
      }
      throw new DotError('dots/unavailable', `Could not create the dot directory: ${String(error)}`)
      /* v8 ignore stop */
    }

    try {
      await mkdir(`${paths.directory}/.dsh-dot`, { recursive: true, mode: 0o700 })
      await writeFile(
        paths.contract,
        renderContract({
          name,
          purpose,
          preset,
          ...(permissionPreset === undefined ? {} : { permissionPreset }),
          ...(allowedTools === undefined ? {} : { allowedTools }),
        }),
        { encoding: 'utf8', mode: 0o600 },
      )
      await writeFile(paths.memory, renderMemory(), { encoding: 'utf8', mode: 0o600 })
      await writeFile(paths.manifest, renderManifest({ id, name, createdAt: now }), {
        encoding: 'utf8',
        mode: 0o600,
      })

      try {
        const workspace = await this.host.createWorkspace(paths.directory, name)
        if (workspace !== undefined) {
          workspaceId = workspace.id
          workspaceCreated = true
        }
      } catch (error: unknown) {
        warnings.push(`Workspace registration failed; the dot runs from its directory only: ${String(error)}`)
      }

      const created = await this.host.createSession({
        directory: paths.directory,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        preset,
      })
      sessionId = created.sessionId
    } catch (error: unknown) {
      const failure = asDotError(error)
      // A session failure always means no home session exists yet, so a workspace
      // that was already registered is the only reason to keep the directory.
      if (!workspaceCreated) {
        try {
          await rm(paths.directory, { recursive: true, force: true })
        } catch {
          // Cleanup only fails on an OS-level fault; the creation failure is reported either way.
        }
        throw new DotError(failure.code, `${failure.message} The dot directory was removed.`)
      }
      throw new DotError(failure.code, `${failure.message} The dot directory is ${paths.directory}.`)
    }

    try {
      await this.host.renameSession(sessionId, name)
    } catch (error: unknown) {
      warnings.push(`The home session could not be renamed: ${String(error)}`)
    }

    if (permissionPreset !== undefined) {
      try {
        await this.host.setPermissionPreset(sessionId, permissionPreset)
      } catch (error: unknown) {
        warnings.push(`Permission preset "${permissionPreset}" could not be applied: ${String(error)}`)
      }
    }

    if (input.model !== undefined) {
      try {
        await this.host.selectModel(sessionId, input.model)
        appliedModel = input.model
      } catch (error: unknown) {
        warnings.push(`Model ${input.model.provider}/${input.model.model} could not be selected: ${String(error)}`)
      }
    }

    const record: DotRecord = {
      version: 1,
      id,
      name,
      purpose,
      directory: paths.directory,
      sessionId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      preset,
      ...(permissionPreset === undefined ? {} : { permissionPreset }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(appliedModel === undefined ? {} : { model: appliedModel }),
      createdAt: now,
      updatedAt: now,
      assignmentCount: 0,
    }

    try {
      const stored = await this.store.add(record, this.config.maxDots)
      return { view: this.view(stored, 'idle'), warnings }
    } catch (error: unknown) {
      const failure = asDotError(error)
      throw new DotError(
        failure.code,
        `${failure.message} The created directory is ${paths.directory} and its home session is ${sessionId}.`,
      )
    }
  }

  /**
   * List dots with live status.
   * @param includeArchived - include archived records.
   * @param signal - optional caller cancellation for the Session list read.
   * @returns views in storage order.
   */
  async list(includeArchived = false, signal?: AbortSignal): Promise<DotView[]> {
    const records = this.store.list(includeArchived)
    const summaries = await this.sessionSummaries(signal)
    return records.map(record => this.view(record, statusOf(record, summaries)))
  }

  /**
   * Assign one task to a dot.
   * @param input - dot reference, task, and optional caller identity.
   * @param signal - optional caller cancellation before the prompt is queued.
   * @returns acceptance, not completion.
   * @throws DotError `dots/invalid` for a blank or oversized task, `dots/not-found`
   *   for an unknown active dot, `dots/session-missing` when the home Session cannot be resumed.
   */
  async assign(input: AssignInput, signal?: AbortSignal): Promise<AssignResult> {
    const record = this.requireActive(input.ref)
    const task = input.task.trim()
    if (task.length === 0) throw new DotError('dots/invalid', 'Assignment text must not be blank.')
    if (Buffer.byteLength(task, 'utf8') > this.config.maxTaskBytes) {
      throw new DotError('dots/invalid', `Assignment must be at most ${this.config.maxTaskBytes} UTF-8 bytes.`)
    }
    signal?.throwIfAborted()
    const memory = await this.readMemory(record)
    const assignmentId = randomBytes(6).toString('hex')
    const frame = this.assignmentFrame(record, task, memory, assignmentId, input.from)
    try {
      await this.host.prompt(record.sessionId, frame, assignmentId, signal)
    } catch (error: unknown) {
      throw new DotError('dots/session-missing', `Could not queue the assignment: ${String(error)}`)
    }

    const now = this.host.now()
    try {
      await this.store.update(record.id, current => ({
        ...current,
        lastAssignedAt: now,
        assignmentCount: current.assignmentCount + 1,
        updatedAt: now,
      }))
    } catch (error: unknown) {
      // The assignment is already queued; record bookkeeping must not turn it into a failure.
      this.warn(`assignment queued to dot "${record.name}" but the record update failed: ${String(error)}`)
    }

    return {
      accepted: true,
      dotId: record.id,
      sessionId: record.sessionId,
      status: 'queued',
    }
  }

  /**
   * Update one dot's contract, memory, or allowlist.
   * @param ref - dot reference.
   * @param input - at least one change.
   * @param signal - optional caller cancellation before the first write.
   * @returns the updated view.
   * @throws DotError `dots/invalid` when no change or a blank memory note is supplied.
   */
  async update(ref: string, input: UpdateDotInput, signal?: AbortSignal): Promise<DotView> {
    const record = this.requireActive(ref)
    if (input.purpose === undefined && input.addMemory === undefined && input.allowedTools === undefined) {
      throw new DotError('dots/invalid', 'Provide purpose, addMemory, or allowedTools.')
    }
    const purpose =
      input.purpose === undefined ? record.purpose : normalizePurpose(input.purpose, this.config.maxPurposeBytes)
    const allowedTools =
      input.allowedTools === undefined ? record.allowedTools : normalizeAllowedTools(input.allowedTools)
    const paths = dotPaths(this.root, record.id)
    signal?.throwIfAborted()

    if (purpose !== record.purpose || input.allowedTools !== undefined) {
      await writeFile(
        paths.contract,
        renderContract({
          name: record.name,
          purpose,
          preset: record.preset,
          ...(record.permissionPreset === undefined ? {} : { permissionPreset: record.permissionPreset }),
          ...(allowedTools === undefined ? {} : { allowedTools }),
        }),
        { encoding: 'utf8', mode: 0o600 },
      )
    }

    if (input.addMemory !== undefined) {
      const note = input.addMemory.trim()
      if (note.length === 0) throw new DotError('dots/invalid', 'addMemory must not be blank.')
      if (Buffer.byteLength(note, 'utf8') > this.config.maxTaskBytes) {
        throw new DotError('dots/invalid', `addMemory must be at most ${this.config.maxTaskBytes} UTF-8 bytes.`)
      }
      const existing = await readFile(paths.memory, 'utf8').catch(() => renderMemory())
      await appendFile(paths.memory, `${existing.endsWith('\n') ? '' : '\n'}${memoryEntry(note, this.host.now())}`, {
        encoding: 'utf8',
        mode: 0o600,
      })
    }

    const now = this.host.now()
    const stored = await this.store.update(record.id, current => ({
      ...current,
      purpose,
      ...(allowedTools === undefined ? {} : { allowedTools }),
      updatedAt: now,
    }))
    return this.view(stored, statusOf(stored, await this.sessionSummaries()))
  }

  /**
   * Create one scheduled assignment for a dot.
   * @param ref - dot reference.
   * @param request - title, prompt, and exactly one schedule selector.
   * @param signal - optional caller cancellation before the schedule is stored.
   * @returns the created schedule summary.
   * @throws DotError `dots/unavailable` without a Schedule service and `dots/invalid`
   *   for a bad title, blank prompt, or selector count other than one.
   */
  async schedule(ref: string, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleResult> {
    const record = this.requireActive(ref)
    const title = request.title.trim()
    const prompt = request.prompt.trim()
    if (title.length === 0 || title.length > 120) {
      throw new DotError('dots/invalid', 'Schedule title must be 1-120 characters.')
    }
    if (prompt.length === 0) throw new DotError('dots/invalid', 'Schedule prompt must not be blank.')
    const selectors = [
      request.after_seconds,
      request.at,
      request.every_seconds,
      request.daily,
      request.weekly,
      request.cron,
    ].filter(value => value !== undefined)
    if (selectors.length !== 1) {
      throw new DotError('dots/invalid', 'Provide exactly one schedule selector.')
    }
    signal?.throwIfAborted()
    const framedPrompt = `[DOT SCHEDULED TASK]
Dot: ${record.name}
Before starting, read AGENTS.md and MEMORY.md in your workspace.

## Task
${prompt}
`
    const created = await this.host.createSchedule(
      record.sessionId,
      { ...request, title, prompt: framedPrompt },
      signal,
    )
    return {
      id: created.id,
      kind: created.kind,
      title: created.title,
      scheduledAt: created.scheduledAt,
    }
  }

  /**
   * List one dot's active schedules.
   * @param ref - dot reference.
   * @param signal - optional caller cancellation.
   * @returns active schedules in storage order.
   * @throws DotError `dots/unavailable` without a Schedule service.
   */
  async scheduleList(ref: string, signal?: AbortSignal): Promise<readonly ScheduleRecordLike[]> {
    const record = this.requireActive(ref)
    signal?.throwIfAborted()
    return await this.host.listSchedules(record.sessionId)
  }

  /**
   * Archive one dot, stopping its schedules and live turn.
   * @param ref - dot reference.
   * @param stopSchedules - delete active schedules first.
   * @param signal - optional caller cancellation before the archive write.
   * @returns archive summary.
   * @throws DotError `dots/not-found` for an unknown active dot.
   */
  async archive(ref: string, stopSchedules = true, signal?: AbortSignal): Promise<ArchiveResult> {
    const record = this.requireActive(ref)
    let deletedSchedules = 0
    const warnings: string[] = []
    if (stopSchedules) {
      try {
        const schedules = await this.host.listSchedules(record.sessionId)
        for (const schedule of schedules) {
          try {
            await this.host.deleteSchedule(record.sessionId, schedule.id, signal)
            deletedSchedules += 1
          } catch (error: unknown) {
            warnings.push(`Could not delete schedule ${schedule.id}: ${String(error)}`)
          }
        }
      } catch (error: unknown) {
        warnings.push(`Could not list schedules for ${record.id}: ${String(error)}`)
      }
    }
    signal?.throwIfAborted()
    const agent = this.host.getAgent(record.sessionId)
    if (agent !== undefined) {
      try {
        agent.cancel({ kind: 'user' })
      } catch (error: unknown) {
        warnings.push(`Could not cancel the live turn: ${String(error)}`)
      }
    }
    await this.store.archive(record.id, this.host.now())
    return {
      archived: true,
      dotId: record.id,
      deletedSchedules,
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  /**
   * Execution-time policy for one tool call.
   * @param sessionId - calling session.
   * @param toolName - tool being invoked.
   * @returns a denial reason, or undefined to allow.
   */
  guardDenial(sessionId: string, toolName: string): string | undefined {
    const record = this.recordOfSession(sessionId)
    if (record === undefined || record.archivedAt !== undefined) return undefined
    if (toolName.startsWith('dot_')) {
      return 'A dot cannot create or manage other dots.'
    }
    if (!this.config.enforceToolAllowlist) return undefined
    const patterns = record.allowedTools
    if (patterns === undefined) return undefined
    const allowed = patterns.some(pattern =>
      pattern.endsWith('*') ? toolName.startsWith(pattern.slice(0, -1)) : toolName === pattern,
    )
    return allowed
      ? undefined
      : `Tool "${toolName}" is not allowed for dot "${record.name}". Allowed: ${patterns.join(', ') || '(none)'}.`
  }

  /**
   * Resolve an active dot reference.
   * @param ref - id or name.
   * @returns the record, or undefined when absent or archived.
   */
  find(ref: string): DotRecord | undefined {
    const record = this.store.find(ref)
    return record?.archivedAt === undefined ? record : undefined
  }

  /**
   * Resolve the dot that owns one Session, directly or through a live ancestor.
   *
   * A subagent Session spawned by a dot is not itself a dot home Session, but
   * it runs that dot's work; inheriting the dot's execution policy keeps
   * "a dot cannot manage other dots" true for every Session in its lineage.
   * @param sessionId - calling Session identity.
   * @returns the owning record, or undefined when no live ancestor is a dot.
   */
  private recordOfSession(sessionId: string): DotRecord | undefined {
    const direct = this.store.findBySession(sessionId)
    if (direct !== undefined) return direct
    for (const ancestor of this.host.parentSessions(sessionId)) {
      const record = this.store.findBySession(ancestor)
      if (record !== undefined) return record
    }
    return undefined
  }

  /**
   * Resolve one active record or throw.
   * @param ref - id or name.
   * @returns the active record.
   */
  private requireActive(ref: string): DotRecord {
    const record = this.find(ref)
    if (record === undefined) {
      throw new DotError('dots/not-found', `No active dot matches "${ref}". Use dot_list.`)
    }
    return record
  }

  /**
   * Validate a requested model against the current model catalog.
   * @param model - provider, model, and optional effort.
   * @throws DotError `dots/invalid` for an unavailable route or effort and
   *   `dots/unavailable` when the catalog cannot be read.
   */
  private async validateModel(model: DotModelSelection): Promise<void> {
    if (model.provider.trim().length === 0 || model.model.trim().length === 0) {
      throw new DotError('dots/invalid', 'Model provider and model id must not be blank.')
    }
    let catalog: DotModelCatalog
    try {
      catalog = await this.host.listModels()
    } catch (error: unknown) {
      throw new DotError('dots/unavailable', `Could not read the model catalog: ${String(error)}`)
    }
    const group = catalog.groups.find(item => item.id === model.provider)
    const info = group?.models.find(item => item.id === model.model)
    if (group === undefined || info === undefined) {
      throw new DotError('dots/invalid', `Model "${model.provider}/${model.model}" is not available.`)
    }
    if (
      model.reasoningEffort !== undefined &&
      model.reasoningEffort.length > 0 &&
      !info.efforts?.some(effort => effort.id === model.reasoningEffort)
    ) {
      throw new DotError(
        'dots/invalid',
        `Reasoning effort "${model.reasoningEffort}" is not available for ${model.provider}/${model.model}.`,
      )
    }
  }

  /**
   * Read a bounded memory excerpt.
   * @param record - dot record.
   * @returns memory text or `none`.
   */
  private async readMemory(record: DotRecord): Promise<string> {
    const text = await readFile(dotPaths(this.root, record.id).memory, 'utf8').catch(() => '')
    return memoryExcerpt(text, this.config.maxMemoryBytes)
  }

  /**
   * Build the model-visible assignment frame.
   * @param record - dot record.
   * @param task - assignment text.
   * @param memory - bounded memory excerpt.
   * @param assignmentId - assignment identity.
   * @param from - caller session identity.
   * @returns the complete user-role prompt text.
   */
  private assignmentFrame(
    record: DotRecord,
    task: string,
    memory: string,
    assignmentId: string,
    from: string | undefined,
  ): string {
    return `[DOT ASSIGNMENT]
Dot: ${record.name}
Dot id: ${record.id}
Purpose: ${record.purpose}
Assignment: ${assignmentId}
From: ${from ?? 'the user'}

## Durable memory
${memory}

## Task
${task}

Work in your workspace. When done, reply with a concise report: what you did, evidence, and anything unresolved.
`
  }

  /**
   * Read every Session row once for live status.
   * @param signal - optional caller cancellation.
   * @returns summaries keyed by Session identity.
   */
  private async sessionSummaries(signal?: AbortSignal): Promise<Map<string, DotSessionSummary>> {
    const summaries = await this.host.listSessions(signal)
    return new Map(summaries.map(item => [item.sessionId, item]))
  }

  /**
   * Project one record into a tool-facing view.
   * @param record - dot record.
   * @param status - live status.
   * @returns detached view.
   */
  private view(record: DotRecord, status: DotStatus): DotView {
    return {
      id: record.id,
      name: record.name,
      purpose: record.purpose,
      directory: record.directory,
      sessionId: record.sessionId,
      ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
      preset: record.preset,
      ...(record.permissionPreset === undefined ? {} : { permissionPreset: record.permissionPreset }),
      ...(record.allowedTools === undefined ? {} : { allowedTools: record.allowedTools }),
      ...(record.model === undefined ? {} : { model: record.model }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.lastAssignedAt === undefined ? {} : { lastAssignedAt: record.lastAssignedAt }),
      assignmentCount: record.assignmentCount,
      ...(record.archivedAt === undefined ? {} : { archivedAt: record.archivedAt }),
      status,
    }
  }
}

/**
 * Derive one dot's status from its Session row.
 * @param record - dot record.
 * @param summaries - Session rows keyed by Session identity.
 * @returns `running` inside a turn, `idle` with a live Agent, `asleep` when only
 *   the Session is stored, and `missing` when the Session row is absent.
 */
function statusOf(record: DotRecord, summaries: Map<string, DotSessionSummary>): DotStatus {
  const summary = summaries.get(record.sessionId)
  if (summary === undefined) return 'missing'
  if (summary.running) return 'running'
  return summary.agentAvailable ? 'idle' : 'asleep'
}
