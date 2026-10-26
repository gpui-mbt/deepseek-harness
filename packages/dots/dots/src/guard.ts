/**
 * Execution-time tool policy for dot home sessions.
 *
 * The listener is a plain `tools/pre-execute` waterfall participant: it denies
 * one call when the controller reports a reason and otherwise delegates to the
 * next listener. Model-facing schemas stay visible; only execution is refused.
 * @module @deepseek-ai/dsh-dots/guard
 */

import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { DotController } from './controller.ts'

/** One `tools/pre-execute` listener backed by the dot controller. */
export type ToolGuard = (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>

/**
 * Build the `tools/pre-execute` listener.
 * @param controller - lifecycle controller whose store knows dot sessions.
 * @returns the waterfall listener.
 */
export function createToolGuard(controller: DotController): ToolGuard {
  return async (exec, next) => {
    const sessionId = exec.agent?.id
    if (sessionId === undefined) return await next()
    const reason = controller.guardDenial(sessionId, exec.name)
    return reason === undefined ? await next() : { kind: 'deny', reason }
  }
}
