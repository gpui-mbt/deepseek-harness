import { Context } from '@deepseek-ai/cordis'
import {
  createClientModuleSystem,
  type ClientBundleRegistration,
  type ClientModuleLoader,
  type ClientModuleLoaderTarget,
  type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import { bootClient } from '../src/boot-client.ts'
import { installConsoleErrorExporter } from '../src/console-logger.ts'

/** Capture `console.error` for one test and restore it afterwards. */
function spyOnConsoleError() {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => {
    error.mockRestore()
  })
  return error
}

/** One-row client boot whose row id differs from the plugin's own (mangled) name. */
function rowModules(rowId: string, plugin: unknown): ClientModuleLoader {
  const graph: WebBootGraph = {
    rev: 'graph',
    entries: [{ id: rowId, url: `/${rowId}.js`, rev: '1' }],
    batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: [rowId] }],
  }
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: registration => {
      pendingQueue.push(registration)
    },
    create: options => createClientModuleSystem(target, { id: '@deepseek-ai/dsh-client-modules', exports: {} }, options),
  }
  return target.create({
    boot: graph,
    staticModules: { [rowId]: plugin },
    loadBundle: async () => {},
  })
}

describe('installConsoleErrorExporter', () => {
  it('reports a record under the Loader row that produced it, not its mangled plugin name', async () => {
    const error = spyOnConsoleError()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    installConsoleErrorExporter(ctx)

    const modules = rowModules('@deepseek-ai/dsh-api-remotes', {
      name: 'nC',
      apply: (rowContext: Context) => {
        rowContext.logger.error(new Error('client api: direct method chatgpt/acknowledgeWelcome is already mounted'))
      },
    })
    await bootClient({ ctx, modules, manifest: modules.manifest })

    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]?.[0]).toContain(
      '[@deepseek-ai/dsh-api-remotes] Error: client api: direct method chatgpt/acknowledgeWelcome is already mounted',
    )
  })

  it('falls back to the logger name and keeps the stack in the console message', () => {
    const error = spyOnConsoleError()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    installConsoleErrorExporter(ctx)

    ctx.logger('boot').error(new Error('kernel failed'))

    expect(error).toHaveBeenCalledOnce()
    const message: unknown = error.mock.calls[0]?.[0]
    expect(typeof message).toBe('string')
    expect(message).toContain('[boot] Error: kernel failed')
    // A crash report keeps only this text, so the stack has to be part of it.
    expect(message).toContain('\n')
  })

  it('renders non-Error arguments through the logger formatter', () => {
    const error = spyOnConsoleError()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    installConsoleErrorExporter(ctx)

    ctx.logger('loader').error('plugin %s did not activate', 'graph')

    expect(error).toHaveBeenCalledExactlyOnceWith('[loader] plugin graph did not activate')
  })

  it('leaves records below the error level to the in-memory buffer', () => {
    const error = spyOnConsoleError()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())

    installConsoleErrorExporter(ctx)
    const logger = ctx.logger('boot')
    logger.info('info')
    logger.warn('warn')
    logger.debug('debug')

    expect(error).not.toHaveBeenCalled()
  })

  it('removes the exporter once its disposer runs', async () => {
    const error = spyOnConsoleError()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())

    const dispose = installConsoleErrorExporter(ctx)
    ctx.logger('boot').error('first')
    await dispose()
    ctx.logger('boot').error('second')

    expect(error).toHaveBeenCalledExactlyOnceWith('[boot] first')
  })
})
