/**
 * The `dotsController` Typert Remote service.
 *
 * One service instance owns the package's Remote namespace `dots` and exposes
 * the minimal stable operation set the Web GUI needs: `list`, `create`,
 * `assign`, `update`, `archive`, `scheduleList`, and `scheduleCreate`. Every
 * operation delegates to {@link DotController}, so the browser and the model
 * tools share one set of lifecycle rules.
 * @module @deepseek-ai/dsh-dots/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { DotController } from './controller.ts'
import type {
  ArchiveResult,
  AssignResult,
  DotView,
  DotsArchiveRequest,
  DotsAssignRequest,
  DotsCreateRequest,
  DotsCreateValue,
  DotsListRequest,
  DotsListValue,
  DotsScheduleCreateRequest,
  DotsScheduleListRequest,
  DotsScheduleListValue,
  DotsUpdateRequest,
  ScheduleResult,
  UpdateDotInput,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Dots Remote API owner, mounted by the `@deepseek-ai/dsh-dots` plugin. */
    dotsController: DotsController
  }
}

/** Remote API over one deployment's durable dots. */
export class DotsController extends TypertRemoteService {
  /**
   * @param ctx - owning Cordis context.
   * @param controller - lifecycle controller shared with the tool guard.
   */
  constructor(
    ctx: Context,
    private readonly controller: DotController,
  ) {
    super(ctx, 'dotsController', { namespace: 'dots' })
  }

  /**
   * List dots with live status.
   * @param request - whether to include archived records.
   * @param signal - optional caller cancellation.
   * @returns visible dots in storage order.
   */
  @Remote('list')
  async list(request: DotsListRequest, signal?: AbortSignal): Promise<DotsListValue> {
    return { dots: await this.controller.list(request.includeArchived === true, signal) }
  }

  /**
   * Create one dot with its workspace directory and home session.
   * @param request - name, purpose, and optional preset/permissions/model.
   * @param signal - optional caller cancellation.
   * @returns the created dot and non-fatal warnings.
   */
  @Remote('create')
  async create(request: DotsCreateRequest, signal?: AbortSignal): Promise<DotsCreateValue> {
    const created = await this.controller.create(
      {
        name: request.name,
        purpose: request.purpose,
        ...(request.preset === undefined ? {} : { preset: request.preset }),
        ...(request.permissionPreset === undefined ? {} : { permissionPreset: request.permissionPreset }),
        ...(request.allowedTools === undefined ? {} : { allowedTools: request.allowedTools }),
        ...(request.model === undefined ? {} : { model: request.model }),
      },
      signal,
    )
    return { view: created.view, warnings: created.warnings }
  }

  /**
   * Queue one assignment on a dot's home session.
   * @param request - dot reference, task text, and optional caller identity.
   * @param signal - optional caller cancellation.
   * @returns acceptance, not completion.
   */
  @Remote('assign')
  async assign(request: DotsAssignRequest, signal?: AbortSignal): Promise<AssignResult> {
    return await this.controller.assign(
      {
        ref: request.dot,
        task: request.task,
        ...(request.from === undefined ? {} : { from: request.from }),
      },
      signal,
    )
  }

  /**
   * Update one dot's purpose, memory, or execution allowlist.
   * @param request - dot reference and the changes to apply.
   * @param signal - optional caller cancellation.
   * @returns the updated dot.
   */
  @Remote('update')
  async update(request: DotsUpdateRequest, signal?: AbortSignal): Promise<DotView> {
    const change: UpdateDotInput = {
      ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
      ...(request.addMemory === undefined ? {} : { addMemory: request.addMemory }),
      ...(request.allowedTools === undefined ? {} : { allowedTools: request.allowedTools }),
    }
    return await this.controller.update(request.dot, change, signal)
  }

  /**
   * Archive one dot, stopping its schedules and live turn.
   * @param request - dot reference and whether to stop its schedules.
   * @param signal - optional caller cancellation.
   * @returns the archive summary.
   */
  @Remote('archive')
  async archive(request: DotsArchiveRequest, signal?: AbortSignal): Promise<ArchiveResult> {
    return await this.controller.archive(request.dot, request.stopSchedules !== false, signal)
  }

  /**
   * List one dot's active schedules.
   * @param request - dot reference.
   * @param signal - optional caller cancellation.
   * @returns active schedules bound to the dot's home session.
   */
  @Remote('scheduleList')
  async scheduleList(request: DotsScheduleListRequest, signal?: AbortSignal): Promise<DotsScheduleListValue> {
    return { schedules: await this.controller.scheduleList(request.dot, signal) }
  }

  /**
   * Create one durable schedule on a dot's home session.
   * @param request - dot reference plus title, prompt, and exactly one timing selector.
   * @param signal - optional caller cancellation.
   * @returns the created schedule summary.
   */
  @Remote('scheduleCreate')
  async scheduleCreate(request: DotsScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleResult> {
    const { dot, ...schedule } = request
    return await this.controller.schedule(dot, schedule, signal)
  }
}
