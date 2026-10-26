/**
 * Adapter from a Cordis Host context to the structural ports the dots
 * lifecycle consumes.
 *
 * The Session controller, Workspace registry, permission presets, and Schedule
 * service are resolved here so the lifecycle itself stays free of Cordis. The
 * Session controller is required; the other three are optional and fail loud
 * only when an operation that needs them runs.
 * @module @deepseek-ai/dsh-dots/host
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolve the `ctx.agents`, `ctx.permissionPresets`, and
// `ctx.workspaceRegistry` service declarations read below.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { DotError } from './errors.ts'
import type {
  DotModelCatalog,
  DotModelSelection,
  DotsAgent,
  DotsHost,
  DotSessionSummary,
  ScheduleCreateRequest,
  ScheduleRecordLike,
} from './types.ts'

/** One never-aborted signal for Host calls whose caller supplied none. */
const NEVER_ABORTED = new AbortController().signal

/** Upper bound on the Session ancestry walk; a real delegation chain is far shorter. */
const MAX_LINEAGE_DEPTH = 32

/**
 * Pick the caller signal or the shared never-aborted signal.
 * @param signal - optional caller cancellation.
 * @returns a signal accepted by the Host services.
 */
function signalOf(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? NEVER_ABORTED
}

/**
 * Build the Host adapter over the services this composition mounts.
 * @param ctx - Host context that injects `sessionController`.
 * @returns the structural Host ports.
 */
export function createDotsHost(ctx: Context): DotsHost {
  const sessions = () => ctx.sessionController

  /**
   * Read the optional Schedule service or throw a model-safe failure.
   * @returns the mounted Schedule service.
   */
  const schedule = () => {
    const service = ctx.get('schedule')
    if (service === undefined) {
      throw new DotError('dots/unavailable', 'This composition does not mount the schedule service.')
    }
    return service
  }

  return {
    async createWorkspace(directory, title) {
      const workspaces = ctx.get('workspaceRegistry')
      if (workspaces === undefined) return undefined
      const workspace = await workspaces.create(directory, title)
      return { id: workspace.id }
    },
    async createSession(input) {
      const created = await sessions().create({
        ...(input.workspaceId === undefined
          ? { cwd: input.directory }
          : { workspaceId: brandString<WorkspaceId>(input.workspaceId) }),
        agentPreset: input.preset,
      })
      return { sessionId: created.sessionId }
    },
    async renameSession(sessionId, title) {
      await sessions().rename({ sessionId: SessionId(sessionId), title })
    },
    async listSessions(signal) {
      const value = await sessions().list({}, signalOf(signal))
      return value.items.map(
        (item): DotSessionSummary => ({
          sessionId: item.sessionId,
          running: item.running,
          agentAvailable: item.agentAvailable,
        }),
      )
    },
    getAgent(sessionId) {
      const agent = ctx.get('agents')?.get(SessionId(sessionId))
      if (agent === undefined) return undefined
      return {
        id: agent.id,
        status: agent.status,
        cancel: (cause, options) => {
          agent.cancel(cause, options)
        },
      } satisfies DotsAgent
    },
    parentSessions(sessionId) {
      const ancestors: string[] = []
      let current = sessionId
      // A persisted Session can only be walked while its Agent is live; the
      // delegation cap bounds real chains well below this guard.
      for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
        const parent = ctx.get('agents')?.get(SessionId(current))?.session.header.parentSession
        if (parent === undefined || ancestors.includes(parent)) break
        ancestors.push(parent)
        current = parent
      }
      return ancestors
    },
    setPermissionPreset(sessionId, name) {
      const presets = ctx.get('permissionPresets')
      if (presets === undefined) {
        throw new DotError('dots/unavailable', 'This composition mounts no permission-preset service.')
      }
      const agent = ctx.get('agents')?.get(SessionId(sessionId))
      if (agent === undefined) {
        throw new DotError('dots/session-missing', `Session "${sessionId}" has no live agent.`)
      }
      presets.set(agent.session, name)
    },
    async listModels(): Promise<DotModelCatalog> {
      const raw = await sessions().modelCatalog()
      return {
        default: raw.default,
        groups: raw.groups.map(group => ({
          id: group.id,
          name: group.name,
          models: group.models.map(model => ({
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(model.reasoning === undefined
              ? {}
              : {
                  efforts: model.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name })),
                  ...(model.reasoning.defaultEffort === undefined
                    ? {}
                    : { defaultEffort: model.reasoning.defaultEffort }),
                }),
          })),
        })),
        failures: raw.failures.map(failure => ({ id: failure.id, name: failure.name, message: failure.message })),
      }
    },
    async selectModel(sessionId: string, selection: DotModelSelection) {
      await sessions().selectModel({
        sessionId: SessionId(sessionId),
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      })
    },
    async prompt(sessionId, text, assignmentId, signal) {
      await sessions().prompt(
        {
          requestId: brandString<SessionRequestId>(assignmentId),
          sessionId: SessionId(sessionId),
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        signalOf(signal),
      )
    },
    async createSchedule(sessionId: string, request: ScheduleCreateRequest, signal?: AbortSignal) {
      const record = await schedule().create(SessionId(sessionId), scheduleRequestOf(request), signalOf(signal))
      return recordLikeOf(record)
    },
    async listSchedules(sessionId: string) {
      const records = await schedule().list({ sessionId: SessionId(sessionId) })
      return records.map(recordLikeOf)
    },
    async deleteSchedule(sessionId: string, id: string, signal?: AbortSignal) {
      return await schedule().delete({ sessionId: SessionId(sessionId), id: ScheduleId(id) }, signalOf(signal))
    },
    now() {
      return Date.now()
    },
  }
}

/**
 * Copy one dots schedule request into the Schedule service's request value.
 * @param request - dots schedule request.
 * @returns the equivalent schedule-service request.
 */
function scheduleRequestOf(request: ScheduleCreateRequest) {
  return {
    prompt: request.prompt,
    title: request.title,
    ...(request.after_seconds === undefined ? {} : { after_seconds: request.after_seconds }),
    ...(request.at === undefined ? {} : { at: request.at }),
    ...(request.every_seconds === undefined ? {} : { every_seconds: request.every_seconds }),
    ...(request.daily === undefined
      ? {}
      : { daily: { time: request.daily.time, time_zone: request.daily.time_zone } }),
    ...(request.weekly === undefined
      ? {}
      : {
          weekly: {
            time: request.weekly.time,
            time_zone: request.weekly.time_zone,
            weekdays: [...request.weekly.weekdays],
          },
        }),
    ...(request.cron === undefined
      ? {}
      : { cron: { expression: request.cron.expression, time_zone: request.cron.time_zone } }),
  }
}

/**
 * Project one stored schedule record onto the subset dots reads.
 * @param record - schedule-service record.
 * @returns the identity, kind, title, and next occurrence.
 */
function recordLikeOf(record: {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly scheduledAt: string
}): ScheduleRecordLike {
  return { id: record.id, kind: record.kind, title: record.title, scheduledAt: record.scheduledAt }
}
