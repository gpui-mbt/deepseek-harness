import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vite-plus/test'
import { bundlePythonRuntimeHelpers } from './build-exe-for-python-sdk.ts'

async function fixture(): Promise<{ root: string; staging: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-python-resource-helpers-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const staging = join(root, 'carrier')
  await mkdir(join(root, 'scripts/primary-runtime'), { recursive: true })
  await mkdir(staging)
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(root, 'tsdown.config.ts'), 'throw new Error("implicit config must not load")\n')
  await writeFile(join(root, 'tsconfig.json'), 'invalid compiler configuration\n')
  await writeFile(join(root, 'scripts/primary-runtime/value.ts'), 'export const value: string = "bundled-runtime"\n')
  await writeFile(join(root, 'scripts/primary-runtime/prepare.ts'), [
    'import { value } from "./value.ts"',
    'export const downloadNodeRuntime = () => value',
    'export const preparePrimaryRuntime = () => import.meta.main',
    'if (import.meta.main) throw new Error("resource helper main must remain disabled")',
  ].join('\n'))
  await writeFile(join(root, 'scripts/build-exe-for-python-sdk-office.ts'), [
    'import { value } from "./primary-runtime/value.ts"',
    'export const downloadOfficeSidecar = () => value + "-office"',
  ].join('\n'))
  return { root, staging }
}

it('bundles Python resource helpers that load under plain Node without their TypeScript sources', async () => {
  const { root, staging } = await fixture()
  await bundlePythonRuntimeHelpers(root, staging)
  expect((await readdir(staging)).some(name => name.startsWith('.resource-helper-'))).toBe(false)
  await rm(join(root, 'scripts'), { recursive: true })
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', [
    'import { downloadNodeRuntime, preparePrimaryRuntime } from "./primary-runtime.mjs"',
    'import { downloadOfficeSidecar } from "./office-sidecar.mjs"',
    'console.log(JSON.stringify([downloadNodeRuntime(), preparePrimaryRuntime(), downloadOfficeSidecar()]))',
  ].join('\n')], { cwd: staging, encoding: 'utf8', timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(['bundled-runtime', false, 'bundled-runtime-office'])
})

it('removes helper entry temporaries when bundling rejects an invalid source', async () => {
  const { root, staging } = await fixture()
  await writeFile(join(root, 'scripts/primary-runtime/prepare.ts'), 'export const broken = (\n')
  await expect(bundlePythonRuntimeHelpers(root, staging)).rejects.toThrow()
  expect((await readdir(staging)).some(name => name.startsWith('.resource-helper-'))).toBe(false)
})
