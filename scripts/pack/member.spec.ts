import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vite-plus/test'
import { runMemberPack } from './member.ts'

async function fixture(): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pack-member-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'packages/util/member')
  await mkdir(directory, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(directory, 'package.json'), '{"name":"fixture-member","type":"module"}\n')
  await writeFile(join(directory, 'source.ts'), 'export const value: string = "member-source"\n')
  await writeFile(join(directory, 'pack.config.ts'), `
import { writeFile } from 'node:fs/promises'
export default ({ env }) => {
  if (env.DSH_BUILD_FACE !== undefined) throw new Error('package-local bundles require the unset face')
  return {
    entry: { index: 'source.ts' }, tsconfig: false, inputOptions: { tsconfig: false },
    hooks: { 'build:done': async () => { await writeFile(new URL('./ready', import.meta.url), 'ready') } },
    plugins: [{ name: 'fixture-close', closeWatcher: async () => { await writeFile(new URL('./closed', import.meta.url), 'closed') } }],
  }
}
`)
  return { root, directory }
}

it('bundles only the current member with explicit source-face config and completed hooks', async () => {
  const { root, directory } = await fixture()
  await runMemberPack([], root, directory)
  expect(await readFile(join(directory, 'lib/index.js'), 'utf8')).toContain('member-source')
  expect(await readFile(join(directory, 'ready'), 'utf8')).toBe('ready')
})

it('owns the member source watchers until cancellation and waits for close', async () => {
  const { root, directory } = await fixture()
  const stop = new AbortController()
  const ready = Promise.withResolvers<undefined>()
  const watching = runMemberPack(['--watch'], root, directory, stop.signal, () => { ready.resolve(undefined) })
  try {
    await ready.promise
    expect(await readFile(join(directory, 'ready'), 'utf8')).toBe('ready')
    await writeFile(join(directory, 'source.ts'), 'export const value: string = "member-source-updated"\n')
    await expect.poll(() => readFile(join(directory, 'lib/index.js'), 'utf8')).toContain('member-source-updated')
  } finally {
    stop.abort()
    await watching
  }
  expect(await readFile(join(directory, 'closed'), 'utf8')).toBe('closed')
})

it('rejects unsupported package-local flags before configuration discovery', async () => {
  await expect(runMemberPack(['--unknown'], '/unused', '/unused')).rejects.toThrow('expected no arguments or --watch')
  await expect(runMemberPack(['--watch', '--watch'], '/unused', '/unused')).rejects.toThrow('expected no arguments or --watch')
})
