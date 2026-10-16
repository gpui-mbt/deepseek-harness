import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'
import { desktopTargetBuildPaths, desktopTargetPlatform } from '../scripts/desktop-build-paths.mjs'
import { resolveDevelopmentRuntime } from '../scripts/development-runtime.ts'

const appRoot = fileURLToPath(new URL('..', import.meta.url))

describe('desktop development runtime', () => {
  it.each(['x64', 'arm64'] as const)('selects the locked Linux %s payload without a release target', (arch) => {
    const runtime = resolveDevelopmentRuntime({}, 'linux', arch)
    expect(runtime).toEqual({
      target: `linux-${arch}`,
      platform: 'linux',
      arch,
      output: join(appRoot, '.desktop-build', 'targets', `linux-${arch}`, 'runtime'),
      cache: join(appRoot, '.desktop-build', 'downloads'),
    })
  })

  it.each([
    ['darwin', 'arm64', 'mac-arm64'],
    ['darwin', 'x64', 'mac-x64'],
    ['win32', 'x64', 'win-x64'],
    ['win32', 'arm64', 'win-x64'],
  ] as const)('preserves %s %s development resources', (platform, arch, target) => {
    const runtime = resolveDevelopmentRuntime({}, platform, arch)
    const paths = desktopTargetBuildPaths(target)
    expect(runtime).toEqual({ target, ...desktopTargetPlatform(target), output: paths.runtime, cache: paths.downloads })
  })

  it('uses DSH target overrides before package-manager overrides', () => {
    expect(resolveDevelopmentRuntime({
      DSH_DESKTOP_TARGET_PLATFORM: 'linux', DSH_DESKTOP_TARGET_ARCH: 'arm64',
      npm_config_platform: 'darwin', npm_config_arch: 'x64',
    }, 'win32', 'x64')).toMatchObject({ target: 'linux-arm64', platform: 'linux', arch: 'arm64' })
    expect(resolveDevelopmentRuntime({ npm_config_platform: 'linux', npm_config_arch: 'x64' }, 'darwin', 'arm64'))
      .toMatchObject({ target: 'linux-x64', platform: 'linux', arch: 'x64' })
    expect(resolveDevelopmentRuntime({ DSH_DESKTOP_TARGET_ARCH: 'x64' }, 'darwin', 'arm64'))
      .toMatchObject({ target: 'mac-x64', platform: 'darwin', arch: 'x64' })
    expect(resolveDevelopmentRuntime({ npm_config_platform: 'win' }, 'linux', 'arm64'))
      .toMatchObject({ target: 'win-x64', platform: 'win32', arch: 'x64' })
  })

  it('shares only the download cache between Linux architectures', () => {
    const x64 = resolveDevelopmentRuntime({}, 'linux', 'x64')
    const arm64 = resolveDevelopmentRuntime({}, 'linux', 'arm64')
    expect(x64.output).not.toBe(arm64.output)
    expect(x64.cache).toBe(arm64.cache)
    expect(x64.cache).toBe(desktopTargetBuildPaths('mac-x64').downloads)
  })

  it('rejects unsupported development payloads', () => {
    expect(() => resolveDevelopmentRuntime({}, 'linux', 's390x'))
      .toThrow('desktop development: unsupported target linux-s390x; use Linux x64 or arm64')
    expect(() => resolveDevelopmentRuntime({}, 'freebsd', 'x64')).toThrow(/unsupported target freebsd-x64/u)
    expect(() => resolveDevelopmentRuntime({ DSH_DESKTOP_TARGET_ARCH: '' }, 'linux', 'x64'))
      .toThrow(/unsupported target linux-/u)
  })

  it.each([{ args: [] }, { args: ['--skip-build'] }])('rejects an unsupported target before builds or project preparation with $args', ({ args }) => {
    const result = spawnSync(process.execPath, [
      '--import', 'tsx/esm', join(appRoot, 'scripts', 'dev.ts'), ...args,
    ], {
      encoding: 'utf8',
      env: { ...process.env, DSH_DESKTOP_TARGET_PLATFORM: 'linux', DSH_DESKTOP_TARGET_ARCH: 's390x', npm_execpath: '' },
      timeout: 20_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim()).toBe('desktop development: unsupported target linux-s390x; use Linux x64 or arm64')
  })
})
