/** Profile configuration and validation for the ChatGPT account plugin. */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ChatGptModelOverride } from './types.ts'

/** Values stored in the profile patch; account tokens live in Credentials instead. */
export interface Config {
  /** Active account selection for this profile. */
  readonly activeAccountId: Volatile<string | undefined>
  /** Whether a Client has acknowledged the first-login welcome view. */
  readonly welcomeAcknowledged: Volatile<boolean>
  /** Start the loopback sign-in flow before a headless task when no account exists. */
  readonly authorizeOnStart: Volatile<boolean>
  /** Per-model capability overrides, also usable from headless profile patches. */
  readonly modelOverrides: Volatile<ChatGptModelOverride[]>
  /** Maximum token/OAuth request duration in milliseconds. */
  readonly requestTimeoutMs: Volatile<number>
  /** Deadline for one sign-in callback after the browser URL is published. */
  readonly loginTimeoutMs: Volatile<number>
  /** Delay between Client snapshots while a sign-in callback is pending. */
  readonly loginPollIntervalMs: Volatile<number>
  /** Quiet period after which an unfinished response stream fails; zero disables the check. */
  readonly streamIdleTimeoutMs: Volatile<number>
}

const modelOverride = z.object({
  model: z.string().min(1).required(),
  contextWindow: z.union([z.number().step(1).min(1), z.const(undefined)]),
  inputModalities: z.union([z.array(z.union(['text', 'image'] as const)).min(1), z.const(undefined)]),
  reasoningEfforts: z.union([z.array(z.string().min(1)).min(1), z.const(undefined)]),
  defaultReasoningEffort: z.union([z.string().min(1), z.const(undefined)]),
})

/** Cordis schema for persistent account selection and ChatGPT capability overrides. */
export const Config: z = z.object({
  activeAccountId: z.string().min(1).volatile(),
  welcomeAcknowledged: z.boolean().default(false).volatile(),
  authorizeOnStart: z.boolean().default(false).volatile(),
  modelOverrides: z.array(modelOverride).default([]).volatile(),
  requestTimeoutMs: z.number().step(1).min(1).max(120_000).default(10_000).volatile(),
  loginTimeoutMs: z.number().step(1).min(1_000).max(30 * 60_000).default(5 * 60_000).volatile(),
  loginPollIntervalMs: z.number().step(1).min(1).max(30_000).default(1_000).volatile(),
  streamIdleTimeoutMs: z.number().step(1).min(0).max(600_000).default(120_000).volatile(),
})

/**
 * Reject a profile whose per-model overrides cannot describe a selectable model.
 * @param overrides - configured overrides in profile order.
 */
export function assertModelOverrides(overrides: readonly ChatGptModelOverride[]): void {
  for (const override of overrides) {
    if (override.defaultReasoningEffort !== undefined
      && override.reasoningEfforts !== undefined
      && !override.reasoningEfforts.includes(override.defaultReasoningEffort)) {
      throw new Error(
        `llm-chatgpt: model override "${override.model}" names default reasoning effort `
        + `"${override.defaultReasoningEffort}" outside its reasoningEfforts list`,
      )
    }
  }
}
