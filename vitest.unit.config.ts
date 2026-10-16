import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite-plus'
import { standardDecoratorPlugin, vitestExecArgv, windowsUnsupportedPackages } from './vitest.shared.ts'
import { COVERAGE_EXEMPT_ENV, coverageExemptHeavySuites } from './scripts/coverage-exempt.ts'
import { COVERAGE_TEST_TIMEOUT_ENV, coverageTestTimeoutOptions } from './scripts/coverage-partitions.ts'
import { LOCAL_TEST_PARALLELISM_CAP, defaultParallelism } from './scripts/parallelism.ts'

// Resolution facade shared by every plugin instance below: tsconfig.base.json
// has no include, which vite-tsconfig-paths treats as match-all, so its paths
// map applies to every test file. paths must win over package exports so built
// lib/ never loads a second module-singleton copy.
const pathsPlugin = (): ReturnType<typeof tsconfigPaths> => tsconfigPaths({ projects: ['./tsconfig.base.json'] })

const windowsUnsupportedTests = process.platform === 'win32'
  ? [
      ...windowsUnsupportedPackages.map(path => `${path}/tests/**/*.spec.ts`),
      'packages/subprocess/subprocess/tests/**/*.spec.ts',
      'packages/subprocess/subprocess-local/tests/local.spec.ts',
      'packages/subprocess/subprocess-local/tests/process-inspector.spec.ts',
      'packages/subprocess/subprocess-local/tests/spawn.spec.ts',
      'packages/subprocess/subprocess-local/tests/terminal.spec.ts',
      // Oracle-diff suites: they compare the worker's POSIX path/url faces
      // against the host Node's own answers, which are win32 semantics on
      // Windows. The worker always speaks POSIX; the Linux lanes hold the diff.
      'packages/experimental/webworker-runtime/tests/node/path-diff.spec.ts',
      'packages/experimental/webworker-runtime/tests/node/shim-diff.spec.ts',
      // The subprocess ladder over the worker's child_process face: its kill
      // rung reaches the in-worker process table through `process.kill`,
      // which the ladder's win32 branch replaces with taskkill-by-real-pid —
      // undeliverable to a table pid. The worker host always reports 'linux',
      // so the Linux lanes hold the ladder.
      'packages/experimental/webworker-runtime/tests/node/child-process.spec.ts',
    ]
  : []

// These suites compare against or assemble the Worker's fixed Linux platform.
// Host-native Windows and macOS behavior is not their oracle.
const nonLinuxWebWorkerTests = process.platform === 'linux'
  ? []
  : [
      'packages/experimental/webworker-runtime/tests/node/fs-watch-stream.spec.ts',
      'packages/experimental/webworker-runtime/tests/node/sandbox-stack.spec.ts',
    ]

const platformUnsupportedTests = [...windowsUnsupportedTests, ...nonLinuxWebWorkerTests]

const testIncludes = [
  'packages/*/*/tests/**/*.spec.{ts,tsx}',
  'apps/*/tests/**/*.spec.{ts,tsx}',
  'scripts/**/*.spec.ts',
  'website/tests/**/*.spec.ts',
]

// The instrumented coverage gate sets this env; the exempt heavy suites then
// run beside it uninstrumented (membership contract in scripts/coverage-exempt.ts).
// A set-but-not-'1' value is a misconfiguration, not a silent no-op.
const coverageExemptRaw = process.env[COVERAGE_EXEMPT_ENV]
if (coverageExemptRaw !== undefined && coverageExemptRaw !== '' && coverageExemptRaw !== '1') {
  throw new Error(`vitest config: ${COVERAGE_EXEMPT_ENV} must be '1' or unset, got ${JSON.stringify(coverageExemptRaw)}.`)
}
const coverageExemptExcludes = coverageExemptRaw === '1'
  ? coverageExemptHeavySuites.map(suite => suite.exclude)
  : []

// Lanes on shared hosts raise the per-test, hook, and expect.poll defaults
// together through DSH_COVERAGE_TEST_TIMEOUT_MS; it lands in each inline
// project below because CLI flags do not reach them (coverageTestTimeoutOptions
// owns the rule and its reach).
const laneTestBudget = coverageTestTimeoutOptions(process.env[COVERAGE_TEST_TIMEOUT_ENV])
// Outside CI, forks follow the local worker budget; CI keeps Vitest's own default for its runner.
const localWorkerBudget = process.env.CI === 'true' ? {} : { maxWorkers: defaultParallelism(process.env, undefined, LOCAL_TEST_PARALLELISM_CAP) }

// These suites exercise process-global state, process APIs, or timing-sensitive process I/O
// that worker threads cannot isolate reliably under aggregate gate contention.
// Keep the narrow exception in forks while the rest of the inventory avoids per-file processes.
const processBoundTests = [
  'packages/session/session-persistence-jsonl/tests/jsonl.spec.ts',
  'packages/subagent/subagent-acp/tests/subagent-acp.spec.ts',
  'packages/subprocess/subprocess-local/tests/process-exit.spec.ts',
  'packages/subprocess/subprocess-local/tests/spawn.spec.ts',
  'packages/context/time-context/tests/time-context.spec.ts',
  'packages/llm/llm-pi-ai/tests/adapter.spec.ts',
  'packages/boot/app-boot/tests/app-boot.spec.ts',
  'packages/workflow/workflow-ptc/tests/workflow-ptc.spec.ts',
]

// Claude Code's test-kit module names, served by the mods bridge's test support so the example mods' tests import them unchanged.
const claudeCodeTestingAliases = {
  'claude-code/testing': fileURLToPath(new URL('./packages/experimental/claude-code-mods/tests/support/claude-code-testing.ts', import.meta.url)),
  'claude-code': fileURLToPath(new URL('./packages/experimental/claude-code-mods/tests/support/claude-code.ts', import.meta.url)),
}

export default defineConfig({
  plugins: [pathsPlugin(), standardDecoratorPlugin()],
  resolve: { alias: claudeCodeTestingAliases },
  test: {
    name: 'unit',
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
    // Vitest v4 compatibility: give each inline project its own Vite server.
    // Remove once no project hook depends on the shared-server lifecycle.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#inline-projects-share-the-vite-server-by-default
    sharedViteServer: false,
    ...localWorkerBudget,
    // One coverage invocation aggregates both projects. Every suite forks for
    // Node stability; process-bound suites stay separate for inventory control.
    // Each project below owns its file inventory: Vitest 5 concatenates an
    // inherited array with the project's own, so declaring one here would run
    // every setup file and glob twice.
    projects: [
      {
        test: {
          name: 'thread-safe',
          execArgv: vitestExecArgv,
          // Node 24 has aborted in its CJS lexer (v8::ToLocalChecked Empty
          // MaybeLocal in cjs_lexer::Parse) from worker threads on macOS,
          // Linux, and Windows. Forked workers avoid that shared thread path.
          pool: 'forks',
          ...laneTestBudget,
          setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-dom-environment.ts'],
          include: testIncludes,
          exclude: [
            ...platformUnsupportedTests,
            ...processBoundTests,
            ...coverageExemptExcludes,
          ],
        },
      },
      {
        test: {
          name: 'process-bound',
          execArgv: vitestExecArgv,
          pool: 'forks',
          ...laneTestBudget,
          setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-dom-environment.ts'],
          include: processBoundTests,
          exclude: [
            ...platformUnsupportedTests,
            ...coverageExemptExcludes,
          ],
        },
      },
    ],
  },
})