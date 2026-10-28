/**
 * Cordis entry for the model-facing dots tools.
 *
 * Mounting this plugin registers the six dot tools in the mounting scope, so a
 * preset decides which agents receive them. Every tool delegates to the
 * `dotsController` service mounted by `@deepseek-ai/dsh-dots`; this package
 * holds no dot state and has no configuration.
 * @module @deepseek-ai/dsh-tool-dots
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves the `ctx.dotsController` service declaration.
import type {} from '@deepseek-ai/dsh-dots'
import { defineDotTools } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-dots'

/** The tool registry and the dots controller are both required. */
export const inject = ['tools', 'dotsController']

/**
 * Register the six dot tools on the mounting context.
 * @param ctx - Host context with `tools` and `dotsController`.
 */
export function apply(ctx: Context): void {
  const dots = ctx.dotsController
  ctx.effect(function* () {
    for (const definition of defineDotTools(dots)) {
      yield ctx.tools.register(definition)
    }
  }, 'tool-dots: dot tools')
}
