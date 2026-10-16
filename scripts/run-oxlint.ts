import { spawnSync } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultParallelism } from './parallelism.ts'
import { removeStagedLintConfig, writeStagedLintConfig } from './staged-lint-config.ts'

// Vite+ owns the Oxlint version this repository lints with, so every
// invocation goes through its CLI rather than a separately pinned `oxlint`
// dependency that could drift from the version `vp` runs.
const vpCli = fileURLToPath(new URL('../node_modules/vite-plus/bin/vp', import.meta.url))
const vpLintArgs = (args: readonly string[]): string[] => ['lint', ...args]
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024 * 1024
const FIX_FLAGS = new Set(['--fix', '--fix-dangerously', '--fix-suggestions'])
/** Selector for the project-free profile the pre-commit hook asks for. */
const STAGED_FLAG = '--staged'

/** The staged selector expanded into a generated project-free config. */
interface StagedProfileResolution {
  /** Arguments to pass on to `vp lint`. */
  args: string[]
  /** Whether this run generated the profile and must delete it before exiting. */
  generated: boolean
}

/**
 * Replace the staged selector with the generated project-free config.
 * @param args - CLI arguments the caller requested.
 * @returns The arguments to pass on, and whether a generated config must be removed afterwards.
 */
function resolveStagedProfile(args: readonly string[]): StagedProfileResolution {
  if (!args.includes(STAGED_FLAG)) return { args: [...args], generated: false }
  return {
    args: args.flatMap(arg => (arg === STAGED_FLAG ? ['--config', writeStagedLintConfig()] : [arg])),
    generated: true,
  }
}

function isFixInvocation(args: readonly string[]): boolean {
  return args.some(arg => FIX_FLAGS.has(arg))
}

function hasOutputFormat(args: readonly string[]): boolean {
  return args.some(arg =>
    arg === '-f'
    || arg.startsWith('-f=')
    || arg === '--format'
    || arg.startsWith('--format='))
}

/** Complete Oxlint child-process arguments and environment. */
export interface OxlintInvocation {
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

/**
 * Apply the repository worker bound to both Oxlint backends.
 * `DSH_OXLINT_THREADS` selects the bound; without it, CI keeps Oxlint's own default and other runs use the
 * [local worker budget](./parallelism.ts). A caller's own `--threads` without `DSH_OXLINT_THREADS` passes through.
 * @param args - Oxlint CLI arguments requested by the caller.
 * @param env - Environment inherited by the Oxlint process.
 * @param cpus - CPU count Node reports for this process.
 * @returns the complete CLI arguments and child environment.
 */
export function resolveOxlintInvocation(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cpus: number = availableParallelism(),
): OxlintInvocation {
  const resolvedArgs = [...args]
  if (env.CI === 'true' && !hasOutputFormat(args)) resolvedArgs.push('--format=default')
  const raw = env.DSH_OXLINT_THREADS
  const explicit = raw !== undefined && raw !== ''
  if (explicit) {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
      throw new Error(`run-oxlint: DSH_OXLINT_THREADS must be a positive integer, got ${JSON.stringify(raw)}.`)
    }
  }
  if (args.some(arg => arg === '--threads' || arg.startsWith('--threads='))) {
    if (explicit) throw new Error('run-oxlint: use DSH_OXLINT_THREADS instead of passing --threads directly.')
    return { args: resolvedArgs, env: { ...env } }
  }
  if (!explicit && env.CI === 'true') return { args: resolvedArgs, env: { ...env } }
  const threads = explicit ? raw : String(defaultParallelism(env, cpus))
  return {
    args: [...resolvedArgs, `--threads=${threads}`],
    env: { ...env, GOMAXPROCS: threads },
  }
}

function completeFrom(result: { readonly signal: NodeJS.Signals | null; readonly status: number | null }): void {
  if (result.signal !== null) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.status ?? 1
}

/** Whether this run wrote the staged profile and must delete it before exiting. */
let generatedProfile = false

function main(): void {
  const staged = resolveStagedProfile(process.argv.slice(2))
  generatedProfile = staged.generated
  try {
    run(staged.args)
  } finally {
    // Every exit path removes the profile it generated, including the early
    // return a clean fix takes.
    if (generatedProfile) removeStagedLintConfig()
  }
}

function run(requested: readonly string[]): void {
  const invocation = resolveOxlintInvocation(requested, process.env)
  if (!isFixInvocation(invocation.args)) {
    const result = spawnSync(process.execPath, [vpCli, ...vpLintArgs(invocation.args)], {
      env: invocation.env,
      stdio: 'inherit',
    })
    if (result.error !== undefined) throw result.error
    completeFrom(result)
    return
  }

  const first = spawnSync(process.execPath, [vpCli, ...vpLintArgs(invocation.args)], {
    encoding: 'utf8',
    env: invocation.env,
    maxBuffer: MAX_CAPTURED_OUTPUT_BYTES,
  })
  if (first.error !== undefined) throw first.error
  if (first.signal !== null) {
    completeFrom(first)
    return
  }
  if (first.status === 0) {
    process.stdout.write(first.stdout)
    process.stderr.write(first.stderr)
    process.exitCode = 0
    return
  }

  // Overlapping JS-plugin fixes can expose one more fixable diagnostic after the first pass.
  const second = spawnSync(process.execPath, [vpCli, ...vpLintArgs(invocation.args)], {
    env: invocation.env,
    stdio: 'inherit',
  })
  if (second.error !== undefined) throw second.error
  completeFrom(second)
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) main()
