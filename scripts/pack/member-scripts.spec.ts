/** Package-local bundle/watch scripts resolve the shared runner and their source pack configs. */
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vite-plus/test'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerPath = '../../../scripts/pack/member.ts'
const commands = {
  bundle: `tsx ${runnerPath}`,
  watch: `tsx ${runnerPath} --watch`,
}

function verifyMemberScripts(root: string): string[] {
  const manifests = globSync('packages/*/*/package.json', { cwd: root }).sort()
  if (manifests.length === 0) throw new Error('empty package manifest corpus')
  const members: string[] = []
  for (const manifest of manifests) {
    const { scripts } = JSON.parse(readFileSync(resolve(root, manifest), 'utf8')) as {
      scripts?: Record<string, string>
    }
    if (scripts?.bundle === undefined && scripts?.watch === undefined) continue
    for (const name of ['bundle', 'watch'] as const) {
      if (scripts?.[name] !== commands[name]) {
        throw new Error(`${manifest}: scripts.${name} must be ${JSON.stringify(commands[name])}`)
      }
    }
    const directory = dirname(resolve(root, manifest))
    const runner = resolve(directory, runnerPath)
    if (runner !== resolve(root, 'scripts/pack/member.ts')) {
      throw new Error(`${manifest}: runner must resolve inside the repository scripts/pack directory`)
    }
    for (const file of [runner, resolve(directory, 'pack.config.ts')]) {
      if (!existsSync(file) || !statSync(file).isFile()) {
        throw new Error(`${manifest}: missing source file ${file}`)
      }
    }
    members.push(manifest.replaceAll('\\', '/'))
  }
  if (members.length === 0) throw new Error('empty bundle/watch script corpus')
  return members
}

async function put(root: string, path: string, content: string): Promise<void> {
  const file = resolve(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-member-scripts-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

async function member(root: string, scripts = commands, config = true, runner = true): Promise<void> {
  await put(root, 'packages/group/member/package.json', JSON.stringify({ scripts }))
  if (config) await put(root, 'packages/group/member/pack.config.ts', 'export default {}\n')
  if (runner) await put(root, 'scripts/pack/member.ts', 'export {}\n')
}

describe('package member bundle/watch scripts', () => {
  it('uses the shared source runner for every declared package bundle/watch pair', () => {
    expect(verifyMemberScripts(repositoryRoot).length).toBeGreaterThan(0)
  })

  it('inspects only actual script values in two-level package manifests', async () => {
    const root = await fixture()
    await member(root)
    await put(root, 'packages/other/member/package.json', JSON.stringify({ scripts: commands }))
    await put(root, 'packages/other/member/pack.config.ts', 'export default {}\n')
    await put(root, 'packages/typert/generator/package.json', JSON.stringify({
      description: 'tsdown --watch is not a script here',
      exports: { './tsdown': './lib/types/tsdown-plugin.js' },
      scripts: { test: 'node test.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await put(root, 'packages/group/member/fixtures/package.json', JSON.stringify({
      scripts: { bundle: 'tsdown', watch: 'tsdown --watch' },
    }))
    await put(root, 'apps/web/package.json', JSON.stringify({ scripts: { bundle: 'vite build' } }))
    await put(root, 'website/package.json', JSON.stringify({ scripts: { watch: 'vitepress dev' } }))
    expect(verifyMemberScripts(root)).toEqual([
      'packages/group/member/package.json',
      'packages/other/member/package.json',
    ])
  })

  it('rejects an empty package corpus and a corpus without member scripts', async () => {
    const root = await fixture()
    expect(() => verifyMemberScripts(root)).toThrow('empty package manifest corpus')
    await put(root, 'packages/group/member/package.json', JSON.stringify({ scripts: { test: 'node test.js' } }))
    expect(() => verifyMemberScripts(root)).toThrow('empty bundle/watch script corpus')
  })

  it.each([
    { scripts: { ...commands, bundle: 'tsdown' }, field: 'bundle' },
    { scripts: { ...commands, watch: 'tsdown --watch' }, field: 'watch' },
    { scripts: { ...commands, bundle: 'tsdown --config custom.config.ts' }, field: 'bundle' },
    { scripts: { ...commands, watch: 'tsx ../../scripts/pack/member.ts --watch' }, field: 'watch' },
    { scripts: { bundle: commands.bundle }, field: 'watch' },
    { scripts: { watch: commands.watch }, field: 'bundle' },
  ])('rejects an unmigrated, atypical, or incomplete $field command', async ({ scripts, field }) => {
    const root = await fixture()
    await put(root, 'packages/group/member/package.json', JSON.stringify({ scripts }))
    expect(() => verifyMemberScripts(root)).toThrow(`scripts.${field} must be`)
  })

  it.each([
    { config: false, runner: true, missing: 'pack.config.ts' },
    { config: true, runner: false, missing: 'scripts/pack/member.ts' },
  ])('rejects a missing $missing source file', async ({ config, runner, missing }) => {
    const root = await fixture()
    await member(root, commands, config, runner)
    expect(() => verifyMemberScripts(root)).toThrow(missing.replaceAll('/', process.platform === 'win32' ? '\\' : '/'))
  })
})
