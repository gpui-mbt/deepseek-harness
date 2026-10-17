/**
 * Process-spawning cases set Vitest's case timeout to 90 seconds, including
 * plain local runs without a CI override. Configuration-only cases keep the default.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'
import { default as baseConfig, stagedLintConfig } from './lint-config.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function runRepositoryOxlint(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [tsxCli, 'scripts/run-oxlint.ts', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
}

function normalizedOutput(result: ReturnType<typeof runRepositoryOxlint>): string {
  return `${result.stdout}${result.stderr}`.replaceAll('\\', '/')
}

async function writeContractConfig(suffix: string): Promise<string> {
  const path = join(repositoryRoot, `vite.config.contract-${suffix}.ts`)
  await writeFile(path, `export default ${JSON.stringify({ lint: { ...baseConfig, ignorePatterns: [] } })}\n`)
  return path
}

describe('Oxlint executable contract', () => {
  it('discovers the owning TypeScript project for every file class', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const probes = [
      ['host package source', 'packages/fs/fs-observation-policy/src', 'packages/fs/fs-observation-policy/tsconfig.json'],
      ['host package test', 'packages/fs/fs-observation-policy/tests', 'tsconfig.host.json'],
      ['client package source', 'packages/client/ui-primitives/src', 'packages/client/ui-primitives/tsconfig.json'],
      // A test under packages/client states its face in the filename, so the
      // probe carries the Client suffix to reach the Client aggregate.
      ['client package test', 'packages/client/ui-trajectory/tests', 'tsconfig.client.json', '.client.ts'],
      ['CLI profile test', 'apps/cli/tests/profiles/headless/tests', 'tsconfig.host.json'],
      ['website', 'website', 'tsconfig.host.json'],
    ] as const
    const source = `export function probePromise(): Promise<void> {
  return Promise.resolve()
}

probePromise()
`

    try {
      const paths: Array<readonly [label: string, path: string, tsconfig: string]> = []
      for (const [label, parent, tsconfig, extension = '.ts'] of probes) {
        const path = join(repositoryRoot, parent, `oxlint-contract-${suffix}${extension}`)
        await writeFile(path, source)
        paths.push([label, relative(repositoryRoot, path), tsconfig])
      }
      const clientScript = 'scripts/client-bundle-purity.spec.ts'

      const result = runRepositoryOxlint(
        ['--config', relative(repositoryRoot, configPath), '--format', 'unix', ...paths.map(([, path]) => path), clientScript],
        { OXC_LOG: 'debug' },
      )
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(1)
      for (const [label, path, tsconfig] of paths) {
        expect(output, label).toContain(`${path.replaceAll('\\', '/')}:5:1: Promises must be awaited`)
        expect(output, `${label} project`).toContain(
          `Got tsconfig for file ${join(repositoryRoot, path).replaceAll('\\', '/')}: ${join(repositoryRoot, tsconfig).replaceAll('\\', '/')}`,
        )
      }
      expect(output.match(/typescript\(no-floating-promises\)/g)).toHaveLength(probes.length)
      expect(output, 'client aggregate script project').toContain(
        `Got tsconfig for file ${join(repositoryRoot, clientScript).replaceAll('\\', '/')}: ${join(repositoryRoot, 'tsconfig.client.json').replaceAll('\\', '/')}`,
      )
      expect(output).not.toContain('Unmatched file:')
    } finally {
      await Promise.all([
        ...probes.map(([, parent, , extension = '.ts']) =>
          rm(join(repositoryRoot, parent, `oxlint-contract-${suffix}${extension}`), { force: true }),
        ),
        rm(configPath, { force: true }),
      ])
    }
  }, 90_000)

  it('runs JavaScript compatibility and nursery rules', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const path = join(repositoryRoot, 'scripts', `oxlint-contract-${suffix}.ts`)
    const source = `export function firstProbe(): number {
  const first = 1
  const second = 2
  return first + second
}

export function secondProbe(): number {
  const first = 1
  const second = 2
  return first + second
}

export function hasValue(value: string): boolean {
  return value !== undefined
}
`

    try {
      await writeFile(path, source)
      const result = runRepositoryOxlint([
        '--config',
        relative(repositoryRoot, configPath),
        '--format',
        'unix',
        relative(repositoryRoot, path),
      ])
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(1)
      expect(output).toContain('sonarjs(no-identical-functions)')
      expect(output).toContain('typescript(no-unnecessary-condition)')
    } finally {
      await Promise.all([rm(path, { force: true }), rm(configPath, { force: true })])
    }
  }, 90_000)

  it('keeps formatting in Oxfmt and the remaining rules in Oxlint', async () => {
    const configText = await readFile(join(repositoryRoot, 'oxlint.config.ts'), 'utf8')
    expect(configText).not.toContain('@stylistic')
    expect(configText).not.toContain("jsPlugins: [\n        '@stylistic/eslint-plugin'")
    expect(baseConfig.ignorePatterns).toEqual(expect.arrayContaining(['packages/typert/generator/tests/fixtures/type-model/**']))

    const typeGraphOverride = baseConfig.overrides.find(
      (value: unknown) =>
        isRecord(value) &&
        isUnknownArray(value.files) &&
        value.files.includes('packages/typert/generator/tests/fixtures/type-model/**/*.{ts,tsx}'),
    )
    expect(typeGraphOverride).toMatchObject({
      rules: { 'typescript/no-explicit-any': 'off' },
    })

    const viteConfig = await readFile(join(repositoryRoot, 'vite.config.ts'), 'utf8')
    expect(viteConfig).toContain('fmt: {')
    expect(viteConfig).toContain('semi: false')
    expect(viteConfig).toContain('singleQuote: true')
  })

  it('checks preserved TypeGraph syntax without type-aware analysis', () => {
    const result = runRepositoryOxlint(['--config', 'vite.staged.config.ts', 'packages/typert/generator/tests/fixtures/type-model'])

    expect(result.error).toBeUndefined()
    expect(result.status, normalizedOutput(result)).toBe(0)
  }, 90_000)

  it('keeps repository lint workflows on Vite+ Oxlint', async () => {
    const packageJson: unknown = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts) || !isRecord(packageJson.devDependencies)) {
      throw new Error('package.json must contain scripts and devDependencies objects')
    }

    expect(packageJson.scripts['lint:contracts-ready']).toBe('tsx scripts/run-oxlint.ts .')
    expect(packageJson.scripts['lint:fix:contracts-ready']).toBe(
      'tsx scripts/run-oxlint.ts --config vite.staged.config.ts packages/typert/generator/tests/fixtures/type-model --fix && tsx scripts/run-oxlint.ts . --fix',
    )
    expect(packageJson.devDependencies).not.toHaveProperty('eslint')
    expect(packageJson.devDependencies).not.toHaveProperty('@typescript-eslint/parser')
    expect(packageJson.devDependencies).not.toHaveProperty('oxlint')
    expect(packageJson.devDependencies).toHaveProperty('vite-plus')
    expect(existsSync(join(repositoryRoot, 'eslint.format.config.mjs'))).toBe(false)

    const lefthook = await readFile(join(repositoryRoot, 'lefthook.yml'), 'utf8')
    expect(lefthook).toContain('scripts/run-oxlint.ts --config vite.staged.config.ts --fix')
    expect(lefthook).not.toContain('node_modules/.bin/eslint')
    expect(lefthook).not.toContain('eslint.format.config.mjs')
  })

  it('reports an unused suppression', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const path = join(repositoryRoot, 'scripts', `oxlint-contract-${suffix}.ts`)

    try {
      await writeFile(path, '// oxlint-disable-next-line no-console\nexport const value = 1\n')
      const result = runRepositoryOxlint([
        '--config',
        relative(repositoryRoot, configPath),
        '--format',
        'unix',
        relative(repositoryRoot, path),
      ])
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(0)
      expect(output).toContain('Unused oxlint-disable directive')
    } finally {
      await Promise.all([rm(path, { force: true }), rm(configPath, { force: true })])
    }
  }, 90_000)

  it('allows Session history reads only in tests or with existing-call waivers', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const testPaths = [
      `packages/core/session/tests/oxlint-contract-${suffix}.ts`,
      `apps/cli/tests/oxlint-contract-${suffix}.ts`,
      `scripts/oxlint-contract-${suffix}.spec.ts`,
    ]
    const productionPaths = [`packages/core/session/src/oxlint-contract-${suffix}.ts`, `scripts/oxlint-contract-${suffix}.ts`]
    const paths = [...testPaths, ...productionPaths]
    const reads = `import { Session, SessionSeq } from '@deepseek-ai/dsh-session'

export function reads(session: Session): void {
  session.snapshotEvents()
  session.eventAt(SessionSeq(0))
  session.ownEvents()
}
`
    const existing = `import { Session, SessionSeq } from '@deepseek-ai/dsh-session'

export function reads(session: Session): void {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  session.snapshotEvents()
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  session.eventAt(SessionSeq(0))
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  session.ownEvents()
}
`
    const unrelated = `
/** @deprecated Use the replacement API. */
function oldApi(): void {}

export function unrelatedRead(): void {
  oldApi()
}
`

    try {
      await Promise.all([
        ...testPaths.map(path => writeFile(join(repositoryRoot, path), reads)),
        ...productionPaths.map(path => writeFile(join(repositoryRoot, path), existing)),
      ])
      const args = ['--config', relative(repositoryRoot, configPath), '--format', 'unix', ...paths]
      const allowed = runRepositoryOxlint(args)
      expect(allowed.error).toBeUndefined()
      expect(allowed.signal).toBeNull()
      expect(allowed.status, normalizedOutput(allowed)).toBe(0)

      await Promise.all([
        ...testPaths.map(path => writeFile(join(repositoryRoot, path), reads + unrelated)),
        ...productionPaths.map(path => writeFile(join(repositoryRoot, path), reads)),
      ])
      const rejected = runRepositoryOxlint(args)
      const output = normalizedOutput(rejected)
      expect(rejected.error).toBeUndefined()
      expect(rejected.signal).toBeNull()
      expect(rejected.status, output).toBe(1)
      const diagnostics = output.split('\n').filter(line => /:\d+:\d+: `\w+` is deprecated\./.test(line))
      for (const path of testPaths) {
        const reported = diagnostics.filter(line => line.startsWith(`${path}:`))
        expect(reported, output).toHaveLength(1)
        expect(reported[0]).toContain('`oldApi` is deprecated')
      }
      for (const path of productionPaths) {
        expect(
          diagnostics.filter(line => line.startsWith(`${path}:`)),
          output,
        ).toHaveLength(3)
      }
      for (const method of ['snapshotEvents', 'eventAt', 'ownEvents', 'oldApi']) {
        expect(output).toContain(`\`${method}\` is deprecated`)
      }
      expect(output).toContain(
        'See the [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).',
      )
    } finally {
      await Promise.all([...paths.map(path => rm(join(repositoryRoot, path), { force: true })), rm(configPath, { force: true })])
    }
  }, 90_000)

  it('accepts an ignored-only staged selection', () => {
    const result = runRepositoryOxlint([
      '--config',
      'vite.staged.config.ts',
      '--fix',
      '--no-error-on-unmatched-pattern',
      'scripts/install-lefthook.mjs',
    ])

    expect(result.error).toBeUndefined()
    expect(result.status, normalizedOutput(result)).toBe(0)
  }, 90_000)

  it('keeps staged validation project-free while preserving source rules', async () => {
    expect(stagedLintConfig).toMatchObject({
      options: { typeAware: false },
    })
    expect(stagedLintConfig.ignorePatterns).not.toContain('packages/typert/generator/tests/fixtures/type-model/**')

    const suffix = randomUUID()
    const path = join(repositoryRoot, 'scripts', `staged-lint-probe-${suffix}.ts`)
    try {
      await writeFile(path, 'var value = 1\nexport { value }\n')
      const lint = runRepositoryOxlint(['--config', 'vite.staged.config.ts', '--format', 'unix', relative(repositoryRoot, path)])
      const output = normalizedOutput(lint)

      expect(lint.error).toBeUndefined()
      expect(lint.status, output).toBe(1)
      expect(output).toContain('no-var')
      expect(output).not.toContain('typescript(')
    } finally {
      await rm(path, { force: true })
    }
  }, 90_000)

  it('preserves successful fix output channels', async () => {
    const suffix = randomUUID()
    const path = join(repositoryRoot, 'scripts', `staged-lint-probe-${suffix}.ts`)

    try {
      await writeFile(path, '// oxlint-disable-next-line no-console\nexport const value = 1\n')
      const result = runRepositoryOxlint(['--config', 'vite.staged.config.ts', '--format', 'unix', '--fix', relative(repositoryRoot, path)])

      expect(result.error).toBeUndefined()
      expect(result.status, normalizedOutput(result)).toBe(0)
      expect(result.stdout).toContain('Unused oxlint-disable directive')
      expect(result.stderr).toBe('')
    } finally {
      await rm(path, { force: true })
    }
  }, 90_000)

  it('prints only the final diagnostics when a fix retry still fails', async () => {
    const suffix = randomUUID()
    const path = join(repositoryRoot, 'scripts', `staged-lint-probe-${suffix}.ts`)

    try {
      await writeFile(
        path,
        `export function first(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  const scaled = total * 2
  return scaled + 1
}

export function second(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  const scaled = total * 2
  return scaled + 1
}
`,
      )
      const result = runRepositoryOxlint(['--config', 'vite.staged.config.ts', '--format', 'unix', '--fix', relative(repositoryRoot, path)])
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(1)
      expect(output.match(/sonarjs\(no-identical-functions\)/g)).toHaveLength(1)
    } finally {
      await rm(path, { force: true })
    }
  }, 90_000)

  it.each(['--fix', '--fix-suggestions', '--fix-dangerously'])(
    'converges Oxlint fixes under %s',
    async fixFlag => {
      const suffix = randomUUID()
      const directory = join(repositoryRoot, 'scripts', `.oxlint-contract-${suffix}`)
      const path = join(directory, 'fix.ts')

      try {
        await mkdir(directory, { recursive: true })
        await writeFile(path, 'var value = 1\nexport { value }\n')

        const relativePath = relative(repositoryRoot, path)
        const lintResult = runRepositoryOxlint(['--config', 'vite.staged.config.ts', fixFlag, relativePath])

        const output = normalizedOutput(lintResult)
        expect(lintResult.error).toBeUndefined()
        if (fixFlag === '--fix-suggestions') {
          // no-var is a safe fix, not a suggestion; the wrapper still exercises the retry path.
          expect(lintResult.status, output).toBe(1)
          expect(output).toContain('no-var')
          await expect(readFile(path, 'utf8')).resolves.toBe('var value = 1\nexport { value }\n')
        } else {
          expect(lintResult.status, output).toBe(0)
          expect(output).not.toContain('no-var')
          await expect(readFile(path, 'utf8')).resolves.toMatch(/^(?:const|let) value = 1\nexport \{ value \}/u)
        }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    90_000,
  )
})
