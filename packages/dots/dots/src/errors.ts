/**
 * Stable failure vocabulary shared by the dots lifecycle, the Remote service,
 * and the model-facing tools.
 * @module @deepseek-ai/dsh-dots/errors
 */

/** One machine-routable dots failure. */
export class DotError extends Error {
  /**
   * @param code - stable dotted code.
   * @param message - human-readable explanation safe to show a model.
   */
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DotError'
  }
}

/**
 * Normalize an unknown thrown value into a {@link DotError}.
 * @param error - caught value.
 * @param fallback - code used for an unrecognized value.
 * @returns the normalized failure.
 */
export function asDotError(error: unknown, fallback = 'dots/internal'): DotError {
  if (error instanceof DotError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new DotError(fallback, message)
}
