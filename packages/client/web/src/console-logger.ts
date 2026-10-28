/**
 * Renderer-console sink for client log records. Cordis retains messages in an
 * in-memory ring buffer, so a plugin failure never reaches the browser console
 * by itself and the Desktop crash report's error-level console tail loses it.
 * @module @deepseek-ai/dsh-client-web/src/console-logger
 */
import { Logger } from '@deepseek-ai/cordis'
import type { Context, Exporter, Message } from '@deepseek-ai/cordis'
// Declaration merge only: `Fiber.entry` names the Loader row that produced a record.
import type {} from '@deepseek-ai/cordis-plugin-loader'

/**
 * Severity threshold selecting error records only. It mirrors Cordis's
 * `LoggerLevel.ERROR` const-enum member, which has no runtime object to import
 * (the same constraint as `FIBER_STATE`).
 */
const EXPORTED_LEVEL = 0

/**
 * Name the source of a record. A client bundle mangles plugin function names, so
 * the owning Loader row's package name is what a reader can act on; a record
 * with no Loader row falls back to its logger name.
 * @param message - record whose origin is reported.
 * @returns the owning row's package name, or the logger name.
 */
function sourceName(message: Message): string {
  return message.fiber?.deref()?.entry?.options.name ?? message.name
}

/**
 * Export every error-level client log record to the renderer console, where a
 * fatal failure keeps it in the carrier's crash report. The record is rendered
 * into the console message instead of being forwarded as separate arguments
 * because the crash report retains only that text, which would otherwise drop
 * an `Error`'s stack.
 * @param ctx - root Context carrying the logger service.
 * @returns disposer removing the exporter; the root fiber also disposes it.
 */
export function installConsoleErrorExporter(ctx: Context): ReturnType<Context['logger']['exporter']> {
  const exporter: Exporter = {
    levels: { default: EXPORTED_LEVEL },
    export(message) {
      console.error(`[${sourceName(message)}] ${Logger.format(this, message)}`)
    },
  }
  return ctx.logger.exporter(exporter)
}
