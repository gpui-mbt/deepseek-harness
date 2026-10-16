/** Development entry tests replace downloads and processes, not target selection or launch orchestration. */

import type { SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const operations = vi.hoisted(() => ({
  spawn: vi.fn<(command: string, args: readonly string[], options: SpawnOptions) => EventEmitter>(),
  version: vi.fn(), project: vi.fn(), prepare: vi.fn(), app: vi.fn(),
}))
vi.mock('node:child_process', () => ({ spawn: operations.spawn, execFileSync: operations.version }))
vi.mock('node:module', () => ({ createRequire: () => () => '/fixture/electron' }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: () => true }))
vi.mock('../scripts/development-project.ts', () => ({ prepareDevelopmentProject: operations.project }))
vi.mock('../scripts/prepare-primary-runtime.ts', () => ({ preparePrimaryRuntime: operations.prepare }))
vi.mock('../scripts/development-app.ts', () => ({ prepareDevelopmentApp: operations.app }))

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const originalArgv = process.argv
const originalExitCode = process.exitCode

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM', 'linux')
  vi.stubEnv('DSH_DESKTOP_TARGET_ARCH', 'x64')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', undefined)
  vi.stubEnv('DSH_DESKTOP_MAIN_INSPECT_PORT', '49229')
  vi.stubEnv('DSH_DESKTOP_RENDERER_DEBUG_PORT', '49222')
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', '49230')
  vi.stubEnv('npm_execpath', '/fixture/pnpm.cjs')
  operations.version.mockReturnValue('24.17.0\n')
  operations.app.mockReturnValue('/fixture/HarnessDev')
  operations.spawn.mockImplementation(() => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0, null))
    return child
  })
})

afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExitCode
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('desktop development entry', () => {
  it.each([{ args: [], builds: 2 }, { args: ['--skip-build'], builds: 0 }])(
    'passes the selected Linux payload through preparation and launch with $args',
    async ({ args, builds }) => {
      process.argv = [process.execPath, join(appRoot, 'scripts/dev.ts'), ...args]
      await import('../scripts/dev.ts')
      const output = join(appRoot, '.desktop-build/targets/linux-x64/runtime')
      expect(operations.project).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ platform: 'linux', arch: 'x64' }))
      expect(operations.prepare).toHaveBeenCalledExactlyOnceWith({ preparation: {
        target: 'linux-x64', platform: 'linux', arch: 'x64', output,
        cache: join(appRoot, '.desktop-build/downloads'),
      } })
      const buildCalls = operations.spawn.mock.calls.filter(([command]) => command === process.execPath)
      expect(buildCalls).toHaveLength(builds)
      if (builds > 0) {
        expect(buildCalls.map(([, argv]) => argv)).toEqual([
          ['/fixture/pnpm.cjs', 'run', 'build:artifacts'], ['/fixture/pnpm.cjs', 'run', 'build'],
        ])
      }
      const launch = operations.spawn.mock.calls.at(-1)
      expect(operations.spawn).toHaveBeenCalledTimes(builds + 1)
      expect(launch?.[2]).toMatchObject({ env: { DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(output, 'primary-runtime') } })
      expect(console.error).not.toHaveBeenCalled()
    },
  )

  it('does not launch Electron after payload preparation fails', async () => {
    process.argv = [process.execPath, join(appRoot, 'scripts/dev.ts'), '--skip-build']
    operations.prepare.mockRejectedValueOnce(new Error('payload download failed'))
    await import('../scripts/dev.ts')
    expect(operations.spawn).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledExactlyOnceWith('payload download failed')
    expect(process.exitCode).toBe(1)
  })
})
