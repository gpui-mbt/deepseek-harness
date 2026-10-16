/** Desktop carriers keep a complete interpreter payload even when SDK carriers choose Python-only. */

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { desktopTargetBuildPaths } from '../scripts/desktop-build-paths.mjs'
import { preparePrimaryRuntime, smokePrimaryRuntime } from '../scripts/prepare-primary-runtime.ts'

const payload = vi.hoisted(() => ({ prepare: vi.fn(), smoke: vi.fn() }))
vi.mock('../../../scripts/primary-runtime/prepare.ts', () => ({
  preparePrimaryRuntime: payload.prepare,
  smokePrimaryRuntime: payload.smoke,
}))

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it('prepares an explicit Linux development payload without resolving a release target', async () => {
  const preparation = { target: 'linux-x64', output: '/development/runtime', cache: '/development/downloads' } as const
  await preparePrimaryRuntime({ preparation, deferSmoke: true })
  expect(payload.prepare).toHaveBeenCalledExactlyOnceWith({ ...preparation, version })
  expect(payload.smoke).not.toHaveBeenCalled()
})

it('preserves the packaging target when development preparation is omitted', async () => {
  vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM', 'darwin')
  vi.stubEnv('DSH_DESKTOP_TARGET_ARCH', 'x64')
  const paths = desktopTargetBuildPaths('mac-x64')
  await preparePrimaryRuntime({ deferSmoke: true })
  expect(payload.prepare).toHaveBeenCalledExactlyOnceWith({
    target: 'mac-x64', output: paths.runtime, cache: paths.downloads, version,
  })
})

it('propagates preparation failures before executing payload checks', async () => {
  const error = new Error('payload download failed')
  payload.prepare.mockRejectedValueOnce(error)
  await expect(preparePrimaryRuntime({ preparation: { target: 'linux-arm64', output: '/runtime', cache: '/downloads' } }))
    .rejects.toBe(error)
  expect(payload.smoke).not.toHaveBeenCalled()
})

it('checks the explicitly prepared native payload before returning', async () => {
  const output = await mkdtemp(join(tmpdir(), 'desktop-native-runtime-'))
  try {
    const root = join(output, 'primary-runtime')
    await mkdir(root)
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
      desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
      python: '3.12.14', node: '24.17.0', pnpm: '11.7.0', pythonPackages: { numpy: '2.3.5', pandas: '3.0.1' },
    }))
    await preparePrimaryRuntime({ preparation: { target: 'linux-x64', output, cache: join(output, 'downloads') } })
    expect(payload.smoke).toHaveBeenCalledExactlyOnceWith(root, expect.any(Object))
  } finally { await rm(output, { recursive: true, force: true }) }
})

it('rejects a Python-only native Desktop payload before executing interpreters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-python-only-'))
  try {
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
      desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
      python: '3.12.14', pythonPackages: { numpy: '2.3.5', pandas: '3.0.1' },
    }))
    expect(() => { smokePrimaryRuntime(root) }).toThrow('Desktop payload must declare node and pnpm')
  } finally { await rm(root, { recursive: true, force: true }) }
})
