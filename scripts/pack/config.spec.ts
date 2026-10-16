/** Source-plane coverage for pack composition and the public resolver; built Typert is a private fixture only. */
import { spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { UserConfig } from 'vite-plus/pack'
import { createPackEntries } from '../../pack.config.ts'
import { composeMemberEntries, type MemberPackConfig, type PackMode } from './config.ts'
import { packTargetPasses, parsePackTarget } from './targets.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-pack-config-'))
  roots.push(root)
  await writeFile(resolve(root, 'package.json'), '{"name":"@fixture/root","type":"module"}\n')
  return root
}

async function put(root: string, path: string, content: string): Promise<void> {
  const file = resolve(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

async function member(root: string, directory: string, config?: string): Promise<void> {
  await put(root, `${directory}/package.json`, JSON.stringify({ name: `manifest:${directory}`, type: 'module' }))
  if (config !== undefined) await put(root, `${directory}/pack.config.ts`, config)
}

function firstPlugin(config: UserConfig | undefined): object {
  expect(config).toBeDefined()
  const plugins = config?.plugins
  if (!Array.isArray(plugins) || typeof plugins[0] !== 'object' || plugins[0] === null) {
    throw new Error('fixture expected the shared workspace plugin first')
  }
  return plugins[0]
}

describe('member config composition', () => {
  const directory = resolve('fixture-member')
  const base = { directory, name: '@fixture/member' }

  it('uses defaults once and distinguishes an empty config array from an explicit skip', () => {
    const defaults = composeMemberEntries(base, 'host', {})
    expect(defaults).toHaveLength(1)
    expect(defaults[0]).toMatchObject({
      cwd: directory, name: '@fixture/member', entry: ['lib/types/{index,startup}.js'],
      format: ['esm'], platform: 'node', clean: false,
    })
    expect(defaults[0]?.plugins).toBeUndefined()
    expect(composeMemberEntries({ ...base, config: [] }, 'host', {})).toEqual(defaults)
    expect(composeMemberEntries({ ...base, config: () => [] }, 'host', {})).toEqual(defaults)
    expect(composeMemberEntries({ ...base, config: { entry: '' } }, 'host', {})).toEqual([])
    expect(composeMemberEntries(base, 'client', {})).toEqual([])
    expect(composeMemberEntries({ ...base, config: [] }, 'client', {})).toEqual([])
  })

  it('preserves hook functions, member plugins, overrides, and relative working directories', () => {
    const done = () => {}
    const hooks = { 'build:done': done }
    const plugin = { name: 'member-plugin' }
    const config: UserConfig = {
      cwd: 'nested', name: '@fixture/member/worker', entry: ['worker.ts'],
      hooks, onSuccess: done, plugins: [plugin], outputOptions: { codeSplitting: false },
    }
    const [result] = composeMemberEntries({ ...base, config }, 'standalone', {})
    expect(result).toMatchObject({
      cwd: resolve(directory, 'nested'), name: '@fixture/member/worker', entry: ['worker.ts'],
      outputOptions: { codeSplitting: false },
    })
    expect(result?.hooks).toEqual(hooks)
    expect(result?.onSuccess).toBe(done)
    expect(result?.plugins).toEqual([plugin])
    expect(config.cwd).toBe('nested')
    const absolute = resolve('external-cwd')
    expect(composeMemberEntries({ ...base, config: { cwd: absolute } }, 'host', {})[0]?.cwd).toBe(absolute)
  })

  it.each<PackMode>(['host', 'client', 'watch', 'standalone'])('selects canonical factory env for %s', (mode) => {
    const environment = { DSH_BUILD_FACE: 'stale', KEEP: 'preserved' }
    let observed: Pick<UserConfig, 'env'> | undefined
    const config: MemberPackConfig = (context) => {
      observed = context
      return { entry: context.env?.DSH_BUILD_FACE === undefined ? 'src/client/index.ts' : 'lib/types/client/index.js' }
    }
    const [entry] = composeMemberEntries({ ...base, config }, mode, environment)
    const face = mode === 'host' || mode === 'client' ? mode : undefined
    expect(observed?.env?.DSH_BUILD_FACE).toBe(face)
    expect(observed?.env?.KEEP).toBe('preserved')
    expect(entry?.entry).toBe(face === undefined ? 'src/client/index.ts' : 'lib/types/client/index.js')
    expect(environment).toEqual({ DSH_BUILD_FACE: 'stale', KEEP: 'preserved' })
  })
})

describe('public pack resolver', () => {
  it('discovers manifests and newly added configs dynamically in directory order', async () => {
    const root = await fixtureRoot()
    await member(root, 'packages/z/last', 'export default { entry: "z.ts" }\n')
    await member(root, 'vendor/first', 'export default { entry: "v.ts" }\n')
    await member(root, 'apps/cli', 'export default { entry: "cli.ts" }\n')
    await member(root, 'apps/desktop', 'throw new Error("standalone-only desktop must not load")\n')
    await member(root, 'benchmarks', 'throw new Error("standalone-only benchmarks must not load")\n')
    const entries = await createPackEntries({ root, mode: 'watch' })
    expect(entries.map(entry => entry.name)).toEqual([
      'manifest:apps/cli', 'manifest:packages/z/last', 'manifest:vendor/first',
    ])
    expect(entries.map(entry => entry.cwd)).toEqual([
      resolve(root, 'apps/cli'), resolve(root, 'packages/z/last'), resolve(root, 'vendor/first'),
    ])
    await member(root, 'packages/a/new', 'export default { entry: "new.ts", cwd: "nested" }\n')
    expect((await createPackEntries({ root, mode: 'watch' })).map(entry => entry.cwd)).toEqual([
      resolve(root, 'apps/cli'), resolve(root, 'packages/a/new/nested'),
      resolve(root, 'packages/z/last'), resolve(root, 'vendor/first'),
    ])
  })

  it('reloads changed member config contents at the same path', async () => {
    const root = await fixtureRoot()
    const directory = 'packages/g/reload'
    await member(root, directory, 'export default { entry: "before.ts" }\n')
    expect((await createPackEntries({ root, mode: 'watch' }))[0]?.entry).toBe('before.ts')
    await put(root, `${directory}/pack.config.ts`, 'export default { entry: "after.ts" }\n')
    expect((await createPackEntries({ root, mode: 'watch' }))[0]?.entry).toBe('after.ts')
  })

  it('loads built Typert only for Host and shares one fresh instance across every Host entry', async () => {
    const root = await fixtureRoot()
    await member(root, 'packages/g/default')
    await member(root, 'packages/g/custom', [
      'const plugin = { name: "member-plugin" }',
      'export default [{ entry: "one.ts", plugins: [plugin] }, { entry: "two.ts" }]',
    ].join('\n'))
    await put(root, 'packages/typert/generator/lib/types/tsdown-plugin.js', [
      'let created = 0',
      'export function typertPlugin(options) {',
      '  return { name: "fixture-built-typert", created: ++created, options }',
      '}',
    ].join('\n'))
    await put(root, 'packages/typert/generator/src/tsdown-plugin.ts', 'throw new Error("source Typert must never load")\n')
    const first = await createPackEntries({ root, mode: 'host' })
    expect(first).toHaveLength(3)
    const shared = firstPlugin(first[0])
    expect(shared).toMatchObject({ created: 1, options: { mode: 'workspace', faces: ['host'] } })
    for (const entry of first) expect(firstPlugin(entry)).toBe(shared)
    expect(first[0]?.plugins).toEqual([shared, [{ name: 'member-plugin' }]])
    const second = await createPackEntries({ root, mode: 'host' })
    expect(firstPlugin(second[0])).not.toBe(shared)
    expect(firstPlugin(second[0])).toMatchObject({ created: 2 })
    for (const entry of second) expect(firstPlugin(entry)).toBe(firstPlugin(second[0]))
  })

  it.each<PackMode>(['client', 'watch', 'standalone'])('does not require or evaluate built Typert for %s', async (mode) => {
    const root = await fixtureRoot()
    const directory = 'packages/g/no-typert'
    await member(root, directory, 'export default ({ env }) => ({ entry: env.DSH_BUILD_FACE === undefined ? "src/client/index.ts" : "lib/types/client/index.js" })\n')
    const options = { root, mode, members: [directory] }
    expect((await createPackEntries(options))[0]?.entry).toBe(mode === 'client' ? 'lib/types/client/index.js' : 'src/client/index.ts')
    await put(root, 'packages/typert/generator/lib/types/tsdown-plugin.js', 'throw new Error("Typert must not load")\n')
    expect(await createPackEntries(options)).toHaveLength(1)
  })

  it('fails a Host pass without its built generator instead of falling back to source', async () => {
    const root = await fixtureRoot()
    await member(root, 'packages/g/host')
    await put(root, 'packages/typert/generator/src/tsdown-plugin.ts', 'export function typertPlugin() { return { name: "source" } }\n')
    await expect(createPackEntries({ root, mode: 'host' })).rejects.toThrow(/tsdown-plugin\.js/)
  })

  it('rejects relative roots, unknown members, empty selections, and a fully skipped pass', async () => {
    const root = await fixtureRoot()
    await expect(createPackEntries({ root: '.', mode: 'watch' })).rejects.toThrow('root must be absolute')
    await expect(createPackEntries({ root, mode: 'watch' })).rejects.toThrow('empty workspace corpus')
    await member(root, 'packages/g/skip', 'export default { entry: "" }\n')
    await expect(createPackEntries({ root, mode: 'watch', members: ['packages/g/missing'] })).rejects.toThrow('unknown workspace member')
    await expect(createPackEntries({ root, mode: 'watch', members: [] })).rejects.toThrow('empty workspace corpus')
    await expect(createPackEntries({ root, mode: 'watch' })).rejects.toThrow('no build entries')
    await expect(createPackEntries({ root, mode: 'standalone' })).rejects.toThrow('requires explicit member')
  })

  it('rejects nameless manifests and configs without a default export', async () => {
    const root = await fixtureRoot()
    await put(root, 'packages/g/invalid/package.json', '{}\n')
    await expect(createPackEntries({ root, mode: 'watch' })).rejects.toThrow('nonempty package name')
    await member(root, 'packages/g/invalid', 'export const entry = "not-a-default"\n')
    await expect(createPackEntries({ root, mode: 'watch' })).rejects.toThrow('must default-export')
  })
})

describe('public adapter targets and runner', () => {
  it('loads the dedicated adapter through public vp -C pack and writes only the selected temporary member', async () => {
    const root = await fixtureRoot()
    await member(root, 'benchmarks', 'export default { entry: "entry.ts" }\n')
    await put(root, 'benchmarks/entry.ts', 'export const marker = "public pack sentinel"\n')
    const sourceAdapter = await readFile(new URL('./vite.config.ts', import.meta.url), 'utf8')
    // Rebase only the toolchain import; the adapter still infers its temporary repository root itself.
    await put(root, 'scripts/pack/vite.config.ts', sourceAdapter.replace(
      "'vite-plus'", JSON.stringify(fileURLToPath(import.meta.resolve('vite-plus'))),
    ))
    await put(root, 'scripts/pack/targets.ts', await readFile(new URL('./targets.ts', import.meta.url), 'utf8'))
    await put(root, 'pack.config.ts', `export { createPackEntries } from ${JSON.stringify(fileURLToPath(new URL('../../pack.config.ts', import.meta.url)))}\n`)
    const adapter = resolve(root, 'scripts/pack')
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../../node_modules/vite-plus/bin/vp', import.meta.url)), '-C', adapter, 'pack',
    ], {
      cwd: root, env: { ...process.env, DSH_PACK_TARGET: 'bench', DSH_BUILD_FACE: 'host' },
      encoding: 'utf8', shell: false,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(globSync('**/*.js', { cwd: root }), `${result.stdout}\n${result.stderr}`).toContain('benchmarks/lib/entry.js')
    expect(await readFile(resolve(root, 'benchmarks/lib/entry.js'), 'utf8')).toContain('public pack sentinel')
  })

  it('maps all adapter targets to the shared resolver', () => {
    const root = resolve('repository')
    expect(packTargetPasses(root, 'host')).toEqual([{ root, mode: 'host' }])
    expect(packTargetPasses(root, 'client')).toEqual([{ root, mode: 'client' }])
    expect(() => packTargetPasses(root, 'all')).toThrow('DSH_PACK_TARGET')
    expect(packTargetPasses(root, 'desktop')).toEqual([{ root, mode: 'standalone', members: ['apps/desktop'] }])
    expect(packTargetPasses(root, 'bench')).toEqual([{ root, mode: 'standalone', members: ['benchmarks'] }])
    expect(packTargetPasses(root, 'preview')).toEqual([{
      root, mode: 'standalone', members: ['packages/experimental/webworker-runtime', 'packages/experimental/webworker-packer'],
    }])
    expect(() => packTargetPasses(root, 'unknown')).toThrow('DSH_PACK_TARGET')
    expect(() => packTargetPasses(root, undefined)).toThrow('DSH_PACK_TARGET')
  })

  it('accepts exactly one runner target and rejects flags or unknown targets', () => {
    for (const target of ['host', 'client', 'desktop', 'bench', 'preview']) expect(parsePackTarget([target])).toBe(target)
    for (const args of [[], ['all'], ['unknown'], ['client', '--config', 'other.ts']]) {
      expect(() => parsePackTarget(args)).toThrow('expected exactly one target')
    }
  })

  it.each(['host', 'client', 'desktop', 'bench', 'preview'])('runs %s through pnpm and the public adapter without stale face state', async (target) => {
    const root = await fixtureRoot()
    const pnpm = resolve(root, 'pnpm.mjs')
    await writeFile(pnpm, 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), target: process.env.DSH_PACK_TARGET, face: process.env.DSH_BUILD_FACE }))\n')
    const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)))
    const adapter = fileURLToPath(new URL('.', import.meta.url))
    const result = spawnSync(process.execPath, [
      '--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./run.ts', import.meta.url)), target,
    ], {
      cwd: root,
      env: { ...process.env, npm_execpath: pnpm, DSH_BUILD_FACE: 'stale', DSH_PACK_TARGET: 'stale' },
      encoding: 'utf8', shell: false,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['exec', 'vp', '-C', adapter, 'pack'], cwd: repository,
      target, face: target === 'client' ? 'client' : 'host',
    })
  })
})
