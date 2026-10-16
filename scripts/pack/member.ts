/** Package-local bundle/watch commands share repository entry selection without launching an application. */
import { relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite-plus/pack'
import type { TsdownHandle } from 'vite-plus/pack'
import { createPackEntries } from '../../pack.config.ts'
import { watchClientPlugins } from '../dev-web.ts'

/**
 * Bundle one member or supervise its source/config watchers until cancellation.
 * @param argv - no arguments for a finite bundle, or only --watch.
 * @param root - absolute repository root supplying workspace discovery.
 * @param cwd - member directory selected by the package manager's working directory.
 * @param signal - optional stop signal; watch mode remains active until it aborts or reloading fails.
 * @param onReady - optional notification after every initial build and package hook succeeds.
 * @returns after all owned build/watch resources close; initial and reload failures reject.
 */
export async function runMemberPack(
  argv: readonly string[],
  root: string,
  cwd: string,
  signal?: AbortSignal,
  onReady?: () => void,
): Promise<void> {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--watch')) {
    throw new Error('pack member: expected no arguments or --watch')
  }
  const member = relative(root, cwd).replaceAll('\\', '/')
  if (argv.length === 0) {
    const entries = await createPackEntries({ root, mode: 'watch', members: [member] })
    for (const entry of entries) {
      signal?.throwIfAborted()
      const handle = await build({ ...entry, config: false, watch: false })
      await Promise.all(handle.bundles.map(bundle => bundle[Symbol.asyncDispose]()))
    }
    onReady?.()
    return
  }

  const stopped = Promise.withResolvers<{ kind: 'stopped' } | { kind: 'failed'; error: unknown }>()
  const stop = (): void => { stopped.resolve({ kind: 'stopped' }) }
  signal?.addEventListener('abort', stop, { once: true })
  let handle: TsdownHandle | undefined
  try {
    if (signal?.aborted) return
    handle = await watchClientPlugins(root, [member], undefined, (error) => {
      stopped.resolve({ kind: 'failed', error })
    }, signal)
    onReady?.()
    const result = await stopped.promise
    if (result.kind === 'failed') throw result.error
  } catch (error) {
    if (!signal?.aborted || error !== signal.reason) throw error
  } finally {
    signal?.removeEventListener('abort', stop)
    await handle?.watch.close()
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const abort = new AbortController()
  let exitCode = 0
  const interrupt = (): void => { exitCode = 130; abort.abort(new Error('pack member: interrupted')) }
  const terminate = (): void => { abort.abort(new Error('pack member: terminated')) }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    await runMemberPack(process.argv.slice(2), fileURLToPath(new URL('../..', import.meta.url)), process.cwd(), abort.signal)
  } catch (error) {
    console.error('pack member: build stopped; fix the reported configuration or source and rerun the command', error)
    exitCode = 1
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
  process.exitCode = exitCode
}
