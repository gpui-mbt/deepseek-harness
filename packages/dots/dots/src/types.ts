/**
 * Public value, host-port, and Remote wire types for `dsh-dots`.
 *
 * A dot is a durable named agent: one workspace directory, one home session,
 * one managed `AGENTS.md` contract, and one bounded `MEMORY.md`. Records must
 * survive process restarts, so every persisted field is JSON-safe and every
 * identifier that crosses the Remote wire is branded.
 * @module @deepseek-ai/dsh-dots/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable dot identity, `dot-<slug>-<hex>`. */
export type DotId = Branded<'DotId'>

/** Status of one dot's home session, read from the Session list. */
export type DotStatus = 'running' | 'idle' | 'asleep' | 'missing'

/** One requested model route for a dot's home session. */
export interface DotModelSelection {
  /** Provider route id. */
  readonly provider: string
  /** Exact model id offered by the provider. */
  readonly model: string
  /** Optional reasoning effort id offered by the model. */
  readonly reasoningEffort?: string
}

/** One selectable reasoning effort advertised by a model. */
export interface DotModelEffort {
  /** Effort id accepted by `selectModel`. */
  readonly id: string
  /** Human-readable effort name. */
  readonly name: string
}

/** One model advertised by a provider. */
export interface DotModelInfo {
  /** Exact model id. */
  readonly id: string
  /** Human-readable model name. */
  readonly name: string
  /** Optional model description. */
  readonly description?: string
  /** Reasoning efforts this model accepts, when it advertises any. */
  readonly efforts?: readonly DotModelEffort[]
  /** Effort applied when a request names none. */
  readonly defaultEffort?: string
}

/** One provider group in the model catalog. */
export interface DotModelGroup {
  /** Provider route id. */
  readonly id: string
  /** Human-readable provider name. */
  readonly name: string
  /** Models this provider currently offers. */
  readonly models: readonly DotModelInfo[]
}

/** One provider whose catalog lookup failed. */
export interface DotModelFailure {
  /** Provider route id. */
  readonly id: string
  /** Human-readable provider name. */
  readonly name: string
  /** Failure reported by the provider. */
  readonly message: string
}

/** The deployment's currently routable model catalog. */
export interface DotModelCatalog {
  /** Route used when a dot names no model. */
  readonly default: DotModelSelection
  /** Provider groups with at least one routable model. */
  readonly groups: readonly DotModelGroup[]
  /** Providers whose catalog lookup failed; their models are unavailable. */
  readonly failures: readonly DotModelFailure[]
}

/** One durable dot record, stored in the `dots` storage-domain table. */
export interface DotRecord {
  /** Persisted record schema version. */
  readonly version: 1
  /** Stable dot identity. */
  readonly id: DotId
  /** Display name; unique among active dots, case-insensitively. */
  readonly name: string
  /** Managed purpose rendered into `AGENTS.md`. */
  readonly purpose: string
  /** Absolute dot directory holding the contract and memory. */
  readonly directory: string
  /** Home session identity that survives restarts. */
  readonly sessionId: string
  /** Workspace registration for {@link DotRecord.directory}, when one was created. */
  readonly workspaceId?: string
  /** Agent preset the home session runs. */
  readonly preset: string
  /** Permission preset applied to the home session, when one was requested. */
  readonly permissionPreset?: string
  /** Execution allowlist of tool names or trailing-`*` prefixes. */
  readonly allowedTools?: readonly string[]
  /** Model route selected on the home session at creation time. */
  readonly model?: DotModelSelection
  /** Creation timestamp in milliseconds. */
  readonly createdAt: number
  /** Last mutation timestamp in milliseconds. */
  readonly updatedAt: number
  /** Last accepted assignment timestamp in milliseconds. */
  readonly lastAssignedAt?: number
  /** Number of accepted assignments. */
  readonly assignmentCount: number
  /** Archive timestamp in milliseconds; archived dots are hidden from the default list. */
  readonly archivedAt?: number
}

/** One dot as exposed to tools and the Web GUI, with live session status. */
export interface DotView {
  /** Stable dot identity. */
  readonly id: DotId
  /** Display name. */
  readonly name: string
  /** Managed purpose. */
  readonly purpose: string
  /** Absolute dot directory. */
  readonly directory: string
  /** Home session identity. */
  readonly sessionId: string
  /** Workspace registration for the dot directory, when one exists. */
  readonly workspaceId?: string
  /** Agent preset the home session runs. */
  readonly preset: string
  /** Permission preset applied to the home session, when one was requested. */
  readonly permissionPreset?: string
  /** Execution allowlist of tool names or trailing-`*` prefixes. */
  readonly allowedTools?: readonly string[]
  /** Model route selected at creation time. */
  readonly model?: DotModelSelection
  /** Creation timestamp in milliseconds. */
  readonly createdAt: number
  /** Last mutation timestamp in milliseconds. */
  readonly updatedAt: number
  /** Last accepted assignment timestamp in milliseconds. */
  readonly lastAssignedAt?: number
  /** Number of accepted assignments. */
  readonly assignmentCount: number
  /** Archive timestamp in milliseconds. */
  readonly archivedAt?: number
  /** Live status of the home session. */
  readonly status: DotStatus
}

/** Input accepted when creating one dot. */
export interface CreateDotInput {
  /** Short display name; unique among active dots. */
  readonly name: string
  /** Managed purpose: outcome, sources of truth, quality bar, and escalation rules. */
  readonly purpose: string
  /** Agent preset; the deployment default when omitted. */
  readonly preset?: string
  /** Permission preset applied to the home session. */
  readonly permissionPreset?: string
  /** Execution allowlist of tool names or trailing-`*` prefixes. */
  readonly allowedTools?: readonly string[]
  /** Model route to select on the home session. */
  readonly model?: DotModelSelection
}

/** Input accepted when updating one dot. */
export interface UpdateDotInput {
  /** Replacement purpose; regenerates `AGENTS.md`. */
  readonly purpose?: string
  /** Dated note appended to `MEMORY.md`. */
  readonly addMemory?: string
  /** Replacement execution allowlist; an empty array denies every tool. */
  readonly allowedTools?: readonly string[]
}

/** Result of one accepted assignment. */
export interface AssignResult {
  /** Always true: the assignment entered the dot inbox. */
  readonly accepted: true
  /** Dot that received the assignment. */
  readonly dotId: DotId
  /** Home session identity receiving the assignment. */
  readonly sessionId: string
  /** Whether the assignment was queued rather than executed. */
  readonly status: 'queued'
}

/** Result of archiving one dot. */
export interface ArchiveResult {
  /** Always true: the dot record is archived. */
  readonly archived: true
  /** Archived dot identity. */
  readonly dotId: DotId
  /** Number of active schedules removed before archiving. */
  readonly deletedSchedules: number
  /** Non-fatal failures observed while archiving. */
  readonly warnings?: readonly string[]
}

/** Result of creating one dot schedule. */
export interface ScheduleResult {
  /** Schedule identity. */
  readonly id: string
  /** Schedule kind reported by the schedule service. */
  readonly kind: string
  /** Schedule title. */
  readonly title: string
  /** Next occurrence in canonical UTC form. */
  readonly scheduledAt: string
}

/** The subset of a durable schedule record this package reads. */
export interface ScheduleRecordLike {
  /** Schedule identity. */
  readonly id: string
  /** Schedule kind discriminator. */
  readonly kind: string
  /** Schedule title. */
  readonly title: string
  /** Next occurrence in canonical UTC form. */
  readonly scheduledAt: string
}

/** Daily wall-clock selector accepted by schedule creation. */
export interface DailyScheduleInput {
  /** Local `HH:mm:ss` time. */
  readonly time: string
  /** Explicit UTC or IANA `Area/Location` zone. */
  readonly time_zone: string
}

/** Weekly wall-clock selector accepted by schedule creation. */
export interface WeeklyScheduleInput {
  /** Local `HH:mm:ss` time. */
  readonly time: string
  /** Explicit UTC or IANA `Area/Location` zone. */
  readonly time_zone: string
  /** ISO weekdays, Monday 1 through Sunday 7. */
  readonly weekdays: readonly number[]
}

/** Five-field cron selector accepted by schedule creation. */
export interface CronScheduleInput {
  /** Five-field Vixie cron expression: minute hour day-of-month month day-of-week. */
  readonly expression: string
  /** Explicit UTC or IANA `Area/Location` zone. */
  readonly time_zone: string
}

/** Local-calendar absolute selector accepted by schedule creation. */
export interface LocalAtScheduleInput {
  /** ISO calendar date. */
  readonly date: string
  /** Local wall-clock time. */
  readonly time: string
  /** Explicit UTC or IANA `Area/Location` zone. */
  readonly time_zone: string
}

/** Absolute one-shot selector: an RFC 3339 instant or a local calendar value. */
export type AtScheduleInput = string | LocalAtScheduleInput

/** One schedule creation request, with exactly one timing selector. */
export interface ScheduleCreateRequest {
  /** Reminder text delivered when due. */
  readonly prompt: string
  /** Schedule name of at most 120 characters. */
  readonly title: string
  /** One-shot delay in seconds. */
  readonly after_seconds?: number
  /** Absolute one-shot target. */
  readonly at?: AtScheduleInput
  /** Fixed recurrence interval in seconds, at least 60. */
  readonly every_seconds?: number
  /** Daily wall-clock selector. */
  readonly daily?: DailyScheduleInput
  /** Weekly wall-clock selector. */
  readonly weekly?: WeeklyScheduleInput
  /** Five-field cron selector. */
  readonly cron?: CronScheduleInput
}

/** One live agent's cancel surface, as the dots lifecycle needs it. */
export interface DotsAgent {
  /** Session identity the agent drives. */
  readonly id: string
  /** Whether the agent is inside a turn. */
  readonly status: 'idle' | 'running'
  /**
   * Cancel the active turn.
   * @param cause - stable caller intent carried on the cancellation signal.
   * @param options - cancellation options; `keepInbox` preserves pending work.
   */
  cancel(cause: { readonly kind: 'user' }, options?: { readonly keepInbox?: boolean }): void
}

/** One Session row the dots lifecycle reads for live status. */
export interface DotSessionSummary {
  /** Session identity. */
  readonly sessionId: string
  /** Whether the Session is inside a turn. */
  readonly running: boolean
  /** Whether the Session currently owns a live Agent. */
  readonly agentAvailable: boolean
}

/**
 * Host ports used by the dots lifecycle. The Cordis adapter maps these onto
 * the Session controller, Workspace registry, permission presets, and Schedule
 * service; tests supply a structural fake.
 */
export interface DotsHost {
  /**
   * Register a Workspace for one dot directory.
   * @param directory - absolute dot directory.
   * @param title - Workspace title.
   * @returns the Workspace identity, or undefined when the composition mounts no Workspace registry.
   */
  createWorkspace(directory: string, title: string): Promise<{ readonly id: string } | undefined>

  /**
   * Create the dot's home Session.
   * @param input - directory, optional Workspace binding, and agent preset.
   * @returns the created Session identity.
   */
  createSession(input: {
    readonly directory: string
    readonly workspaceId?: string
    readonly preset: string
  }): Promise<{ readonly sessionId: string }>

  /**
   * Title the home Session after the dot.
   * @param sessionId - home Session identity.
   * @param title - dot display name.
   */
  renameSession(sessionId: string, title: string): Promise<void>

  /**
   * Read every Session row without activating an Agent.
   * @param signal - optional caller cancellation.
   * @returns one summary per visible Session.
   */
  listSessions(signal?: AbortSignal): Promise<readonly DotSessionSummary[]>

  /**
   * Read one live Agent without resuming a cold Session.
   * @param sessionId - home Session identity.
   * @returns the live agent surface, or undefined when the Session is cold.
   */
  getAgent(sessionId: string): DotsAgent | undefined

  /**
   * Walk the live Session ancestry of one Agent, nearest parent first.
   *
   * The execution guard applies a dot's policy to the subagent sessions that
   * dot spawns, so it must know which dot, if any, owns an ancestor Session.
   * Only live Sessions can be walked; a cold ancestor ends the chain.
   * @param sessionId - Session whose ancestry is requested.
   * @returns ancestor Session identities, nearest first.
   */
  parentSessions(sessionId: string): readonly string[]

  /**
   * Apply one permission preset to the home Session's live Agent.
   * @param sessionId - home Session identity.
   * @param name - configured permission preset name.
   */
  setPermissionPreset(sessionId: string, name: string): void | Promise<void>

  /**
   * Read the deployment model catalog.
   * @returns routable provider groups and the deployment default.
   */
  listModels(): Promise<DotModelCatalog>

  /**
   * Install one Session-local model selection.
   * @param sessionId - home Session identity.
   * @param selection - provider, model, and optional reasoning effort.
   */
  selectModel(sessionId: string, selection: DotModelSelection): Promise<void>

  /**
   * Queue one user-role prompt on the home Session.
   * @param sessionId - home Session identity.
   * @param text - complete prompt text.
   * @param assignmentId - stable assignment identity used as the request identity.
   * @param signal - optional caller cancellation.
   */
  prompt(sessionId: string, text: string, assignmentId: string, signal?: AbortSignal): Promise<void>

  /**
   * Create one durable schedule on the home Session.
   * @param sessionId - home Session identity.
   * @param request - title, prompt, and exactly one timing selector.
   * @param signal - optional caller cancellation.
   * @returns the created schedule record.
   * @throws DotError `dots/unavailable` when the composition mounts no Schedule service.
   */
  createSchedule(sessionId: string, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecordLike>

  /**
   * List the home Session's active schedules.
   * @param sessionId - home Session identity.
   * @returns active schedules in storage order.
   * @throws DotError `dots/unavailable` when the composition mounts no Schedule service.
   */
  listSchedules(sessionId: string): Promise<readonly ScheduleRecordLike[]>

  /**
   * Delete one schedule from the home Session.
   * @param sessionId - home Session identity.
   * @param id - schedule identity.
   * @param signal - optional caller cancellation.
   * @returns whatever the schedule service returns.
   * @throws DotError `dots/unavailable` when the composition mounts no Schedule service.
   */
  deleteSchedule(sessionId: string, id: string, signal?: AbortSignal): Promise<unknown>

  /**
   * Read the current wall-clock time.
   * @returns milliseconds since the Unix epoch.
   */
  now(): number
}

/** Request for one dot listing. */
export interface DotsListRequest {
  /** Include archived records. */
  readonly includeArchived?: boolean
}

/** Result of one dot listing. */
export interface DotsListValue {
  /** Visible dots in storage order. */
  readonly dots: readonly DotView[]
}

/** Request for one dot creation. */
export interface DotsCreateRequest {
  /** Short display name; unique among active dots. */
  readonly name: string
  /** Managed purpose. */
  readonly purpose: string
  /** Agent preset; the deployment default when omitted. */
  readonly preset?: string
  /** Permission preset applied to the home session. */
  readonly permissionPreset?: string
  /** Execution allowlist of tool names or trailing-`*` prefixes. */
  readonly allowedTools?: readonly string[]
  /** Model route to select on the home session. */
  readonly model?: DotModelSelection
}

/** Result of one dot creation. */
export interface DotsCreateValue {
  /** The created dot. */
  readonly view: DotView
  /** Non-fatal failures observed while creating the dot. */
  readonly warnings: readonly string[]
}

/** Request for one dot assignment. */
export interface DotsAssignRequest {
  /** Dot id or case-insensitive name. */
  readonly dot: string
  /** Task text, bounded by `maxTaskBytes`. */
  readonly task: string
  /** Caller identity recorded in the assignment frame. */
  readonly from?: string
}

/** Request for one dot update. */
export interface DotsUpdateRequest {
  /** Dot id or case-insensitive name. */
  readonly dot: string
  /** Replacement purpose; regenerates `AGENTS.md`. */
  readonly purpose?: string
  /** Dated note appended to `MEMORY.md`. */
  readonly addMemory?: string
  /** Replacement execution allowlist; an empty array denies every tool. */
  readonly allowedTools?: readonly string[]
}

/** Request for archiving one dot. */
export interface DotsArchiveRequest {
  /** Dot id or case-insensitive name. */
  readonly dot: string
  /** Delete the dot's active schedules first; defaults to true. */
  readonly stopSchedules?: boolean
}

/** Request for one dot's active schedules. */
export interface DotsScheduleListRequest {
  /** Dot id or case-insensitive name. */
  readonly dot: string
}

/** Result of one dot schedule listing. */
export interface DotsScheduleListValue {
  /** Active schedules bound to the dot's home session. */
  readonly schedules: readonly ScheduleRecordLike[]
}

/** Request for creating one dot schedule. */
export interface DotsScheduleCreateRequest extends ScheduleCreateRequest {
  /** Dot id or case-insensitive name. */
  readonly dot: string
}
