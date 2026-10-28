/**
 * Model-facing dot tools.
 *
 * All six tools are thin adapters over the `dotsController` Remote service:
 * validation and lifecycle live in `@deepseek-ai/dsh-dots`, while this package
 * owns only the model-facing descriptions, argument mapping, and result
 * rendering. The definitions are a pure factory so tests can exercise every
 * call without a Cordis context.
 * @module @deepseek-ai/dsh-tool-dots/tools
 */

import type { DotsController } from '@deepseek-ai/dsh-dots'
import type {
  AtScheduleInput,
  CronScheduleInput,
  DailyScheduleInput,
  DotView,
  ScheduleCreateRequest,
  WeeklyScheduleInput,
} from '@deepseek-ai/dsh-dots'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** The `dotsController` operations the model-facing tools call. */
export type DotsToolService = Pick<
  DotsController,
  'list' | 'create' | 'assign' | 'update' | 'archive' | 'scheduleList' | 'scheduleCreate'
>

/**
 * One JSON-safe dot projection.
 *
 * Remote results carry readonly arrays; a tool result must be lossless JSON, so
 * the projection copies every array and keeps only JSON primitives.
 */
type DotJson = {
  id: string
  name: string
  purpose: string
  directory: string
  sessionId: string
  workspaceId?: string
  preset: string
  permissionPreset?: string
  allowedTools?: string[]
  model?: { provider: string; model: string; reasoningEffort?: string }
  createdAt: number
  updatedAt: number
  lastAssignedAt?: number
  assignmentCount: number
  archivedAt?: number
  status: string
}

/**
 * Project one dot into its JSON-safe tool result.
 * @param view - dot view returned by the Remote service.
 * @returns the same fields with detached arrays and plain strings.
 */
function jsonDot(view: DotView): DotJson {
  return {
    id: view.id,
    name: view.name,
    purpose: view.purpose,
    directory: view.directory,
    sessionId: view.sessionId,
    ...(view.workspaceId === undefined ? {} : { workspaceId: view.workspaceId }),
    preset: view.preset,
    ...(view.permissionPreset === undefined ? {} : { permissionPreset: view.permissionPreset }),
    ...(view.allowedTools === undefined ? {} : { allowedTools: [...view.allowedTools] }),
    ...(view.model === undefined
      ? {}
      : {
          model: {
            provider: view.model.provider,
            model: view.model.model,
            ...(view.model.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: view.model.reasoningEffort }),
          },
        }),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    ...(view.lastAssignedAt === undefined ? {} : { lastAssignedAt: view.lastAssignedAt }),
    assignmentCount: view.assignmentCount,
    ...(view.archivedAt === undefined ? {} : { archivedAt: view.archivedAt }),
    status: view.status,
  }
}

/**
 * Read one non-empty string field from a model-supplied selector object.
 * @param value - decoded JSON field.
 * @param label - dotted field path used in the failure message.
 * @returns the string.
 * @throws Error when the field is missing or not a non-empty string.
 */
function textField(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`)
  }
  return value
}

/**
 * Read one model-supplied selector object.
 * @param value - decoded JSON field.
 * @param label - field path used in the failure message.
 * @returns the object's entries.
 * @throws Error when the field is not a JSON object.
 */
function objectField(value: JsonValue, label: string): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value
}

/**
 * Validate one absolute one-shot selector.
 * @param value - model-supplied `at` value.
 * @returns an RFC 3339 string or a local calendar value.
 * @throws Error when the value matches neither accepted form.
 */
function atOf(value: JsonValue): AtScheduleInput {
  if (typeof value === 'string') return value
  const row = objectField(value, 'at')
  return {
    date: textField(row.date, 'at.date'),
    time: textField(row.time, 'at.time'),
    time_zone: textField(row.time_zone, 'at.time_zone'),
  }
}

/**
 * Validate one daily selector.
 * @param value - model-supplied `daily` value.
 * @returns the daily wall-clock selector.
 * @throws Error when `time` or `time_zone` is invalid.
 */
function dailyOf(value: JsonValue): DailyScheduleInput {
  const row = objectField(value, 'daily')
  return { time: textField(row.time, 'daily.time'), time_zone: textField(row.time_zone, 'daily.time_zone') }
}

/**
 * Validate one weekly selector.
 * @param value - model-supplied `weekly` value.
 * @returns the weekly wall-clock selector.
 * @throws Error when a field or weekday is invalid.
 */
function weeklyOf(value: JsonValue): WeeklyScheduleInput {
  const row = objectField(value, 'weekly')
  const raw = row.weekdays
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('weekly.weekdays must be a non-empty array of ISO weekdays 1 through 7.')
  }
  const weekdays: number[] = []
  for (const day of raw) {
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7) {
      throw new Error('weekly.weekdays must be a non-empty array of ISO weekdays 1 through 7.')
    }
    weekdays.push(day)
  }
  return {
    time: textField(row.time, 'weekly.time'),
    time_zone: textField(row.time_zone, 'weekly.time_zone'),
    weekdays,
  }
}

/**
 * Validate one cron selector.
 * @param value - model-supplied `cron` value.
 * @returns the five-field cron selector.
 * @throws Error when the expression or zone is invalid.
 */
function cronOf(value: JsonValue): CronScheduleInput {
  const row = objectField(value, 'cron')
  return {
    expression: textField(row.expression, 'cron.expression'),
    time_zone: textField(row.time_zone, 'cron.time_zone'),
  }
}

/**
 * Render one result value as pretty JSON.
 * @param value - canonical tool result.
 * @returns one text block.
 */
function json(value: JsonValue): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Build the six model-facing dot tool definitions.
 * @param dots - `dotsController` operations the tools delegate to.
 * @returns the definitions in registration order.
 */
export function defineDotTools(dots: DotsToolService): ToolDefinition[] {
  return [
    defineTool({
      name: 'dot_create',
      description:
        'Create a persistent named dot with its own workspace and home session. Use a dot for ongoing work that should continue across assignments. The dot appears as a Workspace and Session in the sidebar.',
      parameters: {
        name: { type: 'string', required: true, description: 'Short unique dot name.' },
        purpose: {
          type: 'string',
          required: true,
          description: "The dot's responsibility: outcome, sources of truth, quality bar, and escalation rules.",
        },
        preset: { type: 'string', description: 'Agent preset; defaults to the deployment dot preset.' },
        provider: { type: 'string', description: 'Model provider id; pair with model.' },
        model: { type: 'string', description: 'Exact model id; pair with provider.' },
        reasoning_effort: { type: 'string', description: 'Optional reasoning effort id for the selected model.' },
        permission_preset: { type: 'string', description: 'Permission preset to apply to the home session.' },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Execution allowlist of tool names or trailing-* prefixes. Omit for all tools.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => [
          {
            type: 'text',
            text: `Created dot ${args.name}. Open its Workspace/Session in the sidebar.\n\n${JSON.stringify(value, null, 2)}`,
          },
        ],
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const provider = args.provider
        const modelId = args.model
        if ((provider === undefined) !== (modelId === undefined)) {
          throw new Error('provider and model must be supplied together.')
        }
        const created = await dots.create(
          {
            name: args.name,
            purpose: args.purpose,
            ...(args.preset === undefined ? {} : { preset: args.preset }),
            ...(args.permission_preset === undefined ? {} : { permissionPreset: args.permission_preset }),
            ...(args.allowed_tools === undefined ? {} : { allowedTools: args.allowed_tools }),
            ...(provider === undefined || modelId === undefined
              ? {}
              : {
                  model: {
                    provider,
                    model: modelId,
                    ...(args.reasoning_effort === undefined
                      ? {}
                      : { reasoningEffort: args.reasoning_effort }),
                  },
                }),
          },
          exec.signal,
        )
        return { view: jsonDot(created.view), warnings: [...created.warnings] }
      },
      presentCall: args => ({ card: 'generic', title: 'Create dot', kind: 'other', rawInput: args.name }),
    }),

    defineTool({
      name: 'dot_list',
      description:
        'List dots with live status (running, idle, asleep, missing). Use it before assigning work so the reference is exact.',
      parameters: {
        include_archived: { type: 'boolean', description: 'Include archived dots.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => json(value),
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const listed = await dots.list({ ...(args.include_archived === undefined ? {} : { includeArchived: args.include_archived }) }, exec.signal)
        return { dots: listed.dots.map(jsonDot) }
      },
      presentCall: () => ({ card: 'generic', title: 'List dots', kind: 'read' }),
    }),

    defineTool({
      name: 'dot_assign',
      description:
        "Queue one task for a dot. This returns when the assignment enters the dot's inbox; it does not mean the task is complete. A running dot receives it on a later turn.",
      parameters: {
        dot: { type: 'string', required: true, description: 'Dot id or name.' },
        task: { type: 'string', required: true, description: 'What the dot should do, with acceptance criteria.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const summary = assignmentSummary(value)
          return [
            {
              type: 'text',
              text: `Assignment queued to ${summary.dotId} (session ${summary.sessionId}). This is acceptance, not completion; use dot_list to check status.`,
            },
          ]
        },
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const accepted = await dots.assign(
          {
            dot: args.dot,
            task: args.task,
            ...(exec.agent === undefined ? {} : { from: exec.agent.id }),
          },
          exec.signal,
        )
        return { accepted: true, dotId: accepted.dotId, sessionId: accepted.sessionId, status: accepted.status }
      },
      presentCall: args => ({ card: 'generic', title: 'Assign to dot', kind: 'other', rawInput: args.dot }),
    }),

    defineTool({
      name: 'dot_update',
      description:
        "Update a dot's managed purpose, append durable memory, or replace its execution allowlist. Use add_memory to record user feedback that should survive future sessions.",
      parameters: {
        dot: { type: 'string', required: true, description: 'Dot id or name.' },
        purpose: { type: 'string', description: 'Replacement purpose; regenerates AGENTS.md.' },
        add_memory: { type: 'string', description: 'Dated note appended to MEMORY.md.' },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement allowlist; pass an empty array to deny all tools.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => json(value),
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const updated = await dots.update(
          {
            dot: args.dot,
            ...(args.purpose === undefined ? {} : { purpose: args.purpose }),
            ...(args.add_memory === undefined ? {} : { addMemory: args.add_memory }),
            ...(args.allowed_tools === undefined ? {} : { allowedTools: args.allowed_tools }),
          },
          exec.signal,
        )
        return jsonDot(updated)
      },
      presentCall: args => ({ card: 'generic', title: 'Update dot', kind: 'other', rawInput: args.dot }),
    }),

    defineTool({
      name: 'dot_schedule',
      description:
        'Create a durable schedule that wakes a dot and delivers a task. Provide exactly one timing selector. The schedule survives restarts and restores the dot from a cold session when due.',
      parameters: {
        dot: { type: 'string', required: true, description: 'Dot id or name.' },
        title: { type: 'string', required: true, description: 'Schedule name, 1-120 characters.' },
        prompt: { type: 'string', required: true, description: 'Task delivered when due.' },
        after_seconds: { type: 'number', description: 'One-shot delay in seconds.' },
        every_seconds: { type: 'number', description: 'Fixed interval in seconds, at least 60.' },
        at: { type: 'json', description: 'Absolute one-shot target: RFC 3339 string or {date,time,time_zone}.' },
        daily: { type: 'json', description: 'Daily selector: {time:"HH:mm:ss", time_zone:"Area/City"}.' },
        weekly: { type: 'json', description: 'Weekly selector: {time, time_zone, weekdays:[1..7]}.' },
        cron: { type: 'json', description: 'Cron selector: {expression:"m h dom mon dow", time_zone}.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => json(value),
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const request: ScheduleCreateRequest = {
          title: args.title,
          prompt: args.prompt,
          ...(args.after_seconds === undefined ? {} : { after_seconds: args.after_seconds }),
          ...(args.every_seconds === undefined ? {} : { every_seconds: args.every_seconds }),
          ...(args.at === undefined ? {} : { at: atOf(args.at) }),
          ...(args.daily === undefined ? {} : { daily: dailyOf(args.daily) }),
          ...(args.weekly === undefined ? {} : { weekly: weeklyOf(args.weekly) }),
          ...(args.cron === undefined ? {} : { cron: cronOf(args.cron) }),
        }
        const created = await dots.scheduleCreate({ dot: args.dot, ...request }, exec.signal)
        return { id: created.id, kind: created.kind, title: created.title, scheduledAt: created.scheduledAt }
      },
      presentCall: args => ({ card: 'generic', title: 'Schedule dot task', kind: 'other', rawInput: args.title }),
    }),

    defineTool({
      name: 'dot_archive',
      description:
        'Archive a dot: stop its active schedules, cancel its running turn, and remove it from the active list. Files and session history are retained.',
      parameters: {
        dot: { type: 'string', required: true, description: 'Dot id or name.' },
        stop_schedules: { type: 'boolean', description: 'Delete active schedules first; defaults to true.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => json(value),
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const archived = await dots.archive(
          {
            dot: args.dot,
            ...(args.stop_schedules === undefined ? {} : { stopSchedules: args.stop_schedules }),
          },
          exec.signal,
        )
        return {
          archived: true,
          dotId: archived.dotId,
          deletedSchedules: archived.deletedSchedules,
          ...(archived.warnings === undefined ? {} : { warnings: [...archived.warnings] }),
        }
      },
      presentCall: args => ({ card: 'generic', title: 'Archive dot', kind: 'other', rawInput: args.dot }),
    }),
  ]
}

/**
 * Read the identity fields of an assignment result for rendering.
 * @param value - rendered assignment result.
 * @returns the dot and session identities, or placeholders when absent.
 */
function assignmentSummary(value: JsonValue): { dotId: string; sessionId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { dotId: '(unknown)', sessionId: '(unknown)' }
  }
  const { dotId, sessionId } = value
  return {
    dotId: typeof dotId === 'string' ? dotId : '(unknown)',
    sessionId: typeof sessionId === 'string' ? sessionId : '(unknown)',
  }
}