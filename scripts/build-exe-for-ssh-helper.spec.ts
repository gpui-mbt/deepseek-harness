import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vite-plus/test'
import { bundleSshHelperRuntime } from './build-exe-for-ssh-helper.ts'

it('bundles the SSH closure with declared helper and runner entry names instead of generic fallback entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-helper-pack-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await symlink(join(import.meta.dirname, '../node_modules'), join(root, 'node_modules'), 'dir')
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(root, 'tsdown.config.ts'), 'throw new Error("implicit root config must not load")\n')
  const fixtures = [
    { directory: 'packages/ssh/ssh-helper-runtime', name: '@deepseek-ai/dsh-ssh-helper-runtime', entries: ['index'] },
    { directory: 'packages/ssh/ssh', name: '@deepseek-ai/dsh-ssh', entries: ['index', 'protocol', 'schemas', 'helper-entry'] },
    { directory: 'packages/subprocess/subprocess-local', name: '@deepseek-ai/dsh-subprocess-local', entries: ['index', 'bin', 'output'] },
  ]
  for (const fixture of fixtures) {
    const directory = join(root, fixture.directory)
    await mkdir(join(directory, 'lib/types'), { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: fixture.name, type: 'module' }))
    await writeFile(join(directory, 'tsdown.config.ts'), 'throw new Error("retired member config must not load")\n')
    if (fixture.directory !== 'packages/ssh/ssh-helper-runtime') {
      await writeFile(join(directory, 'pack.config.ts'), await readFile(join(import.meta.dirname, '..', fixture.directory, 'pack.config.ts'), 'utf8'))
    }
    for (const entry of fixture.entries) {
      await writeFile(join(directory, 'lib/types', `${entry}.js`), `export const marker = ${JSON.stringify(entry)}\n`)
    }
  }
  await mkdir(join(root, 'packages/util/unselected'), { recursive: true })
  await writeFile(join(root, 'packages/util/unselected/package.json'), '{"name":"unselected"}\n')
  await writeFile(join(root, 'packages/util/unselected/pack.config.ts'), 'throw new Error("unselected config must not load")\n')

  await bundleSshHelperRuntime(root, {
    '@deepseek-ai/dsh-ssh': 'workspace:*',
    '@deepseek-ai/dsh-subprocess-local': 'workspace:*',
  })
  expect(await readdir(join(root, 'packages/ssh/ssh/lib'))).toEqual(expect.arrayContaining(['index.js', 'helper.js', 'protocol.js', 'schemas.js']))
  expect(await readdir(join(root, 'packages/subprocess/subprocess-local/lib'))).toEqual(expect.arrayContaining(['index.js', 'runner.js', 'output.js']))
  for (const fixture of fixtures) await rm(join(root, fixture.directory, 'lib/types'), { recursive: true })
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', [
    'import { marker as helper } from "./packages/ssh/ssh/lib/helper.js"',
    'import { marker as runner } from "./packages/subprocess/subprocess-local/lib/runner.js"',
    'console.log(JSON.stringify([helper, runner]))',
  ].join('\n')], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(['helper-entry', 'bin'])
})
