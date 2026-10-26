/**
 * Cordis entry for the dots bundle.
 *
 * Mounting this plugin opens the durable `dots` storage domain, imports the
 * retired JSON-file registry once, registers the `dotsController` Remote
 * service, and installs the execution-time tool guard. The model-facing tools
 * live in `@deepseek-ai/dsh-tool-dots`, which injects `dotsController`.
 * @module @deepseek-ai/dsh-dots
 */

import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { validatePresetAllowlists, type Config } from './config.ts'
import { DotController } from './controller.ts'
import { createToolGuard } from './guard.ts'
import { createDotsHost } from './host.ts'
import { IMPORTED_REGISTRY_SUFFIX, importLegacyRegistry } from './legacy.ts'
import { DotsController } from './service.ts'
import { dotsDomain } from './storage.ts'
import { DotStore } from './store.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dots'

/** The tool registry, the Session controller, and durable storage are all required. */
export const inject = ['tools', 'sessionController', 'storageDomain']

/** Re-export the validated configuration schema and its type. */
export { Config } from './config.ts'
/** The Remote service class, exposed for typed consumers of `ctx.dotsController`. */
export { DotsController } from './service.ts'
/** Every public value type, exposed for tools and other consumers. */
export type * from './types.ts'

/**
 * Resolve the configured dot root.
 * @param configured - configured root, or undefined for `$DSH_HOME/dots`.
 * @returns an absolute dot root.
 */
function resolveRoot(configured: string | undefined): string {
  const value = configured?.trim()
  return value === undefined || value.length === 0
    ? join(resolveDshHome(), 'dots')
    : resolve(expandHomePath(value))
}

/**
 * Mount the dots controller, its Remote service, and the tool guard.
 * @param ctx - Host context with `tools`, `sessionController`, and `storageDomain`.
 * @param config - validated bundle configuration.
 * @returns resolution after the durable domain is open and the legacy registry imported.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  validatePresetAllowlists(config)
  const root = resolveRoot(config.root)
  const host = createDotsHost(ctx)
  const domain = await ctx.storageDomain.open(dotsDomain)
  ctx.effect(
    () => async () => {
      await domain.close()
    },
    'dsh-dots: durable domain',
  )

  const store = new DotStore(domain)
  const legacyFile = join(root, 'registry.json')
  const legacy = await importLegacyRegistry(domain.table('dots'), legacyFile)
  if (legacy.imported > 0) {
    ctx.logger.info(`dots: imported ${legacy.imported} record(s) from ${legacyFile}`)
  }
  if (legacy.leftInPlace) {
    ctx.logger.warn(
      `dots: ${legacyFile} is still present beside a non-empty dots table; it was not imported. ` +
        `Integrate or remove it, then rename it to ${legacyFile}${IMPORTED_REGISTRY_SUFFIX}.`,
    )
  }

  const controller = new DotController(config, host, store, root, message => {
    ctx.logger.warn(message)
  })
  const dots = new DotsController(ctx, controller)
  ctx.on('tools/pre-execute', createToolGuard(controller))
  ctx.logger.debug(`dots: ${dots.name} mounted over ${root} with ${store.list(true).length} record(s)`)
}
