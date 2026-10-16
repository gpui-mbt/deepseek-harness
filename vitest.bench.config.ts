import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite-plus'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/**
 * CI performance gate. Node CPU cases use compiled plain-Node workers under
 * `benchmarks/.dsh-build/`; browser cases drive built Client artifacts through
 * the shared shipped-composition Web scaffold.
 * Files run one at a time so a measurement never shares the CPU with another
 * benchmark.
 */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    name: 'bench',
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-proxy-environment.ts'],
    // Clears recorded timings before the run and renders benchmarks/.dsh-report/report.html after it.
    globalSetup: ['./benchmarks/support/scaling-report.ts'],
    include: [
      'benchmarks/**/*.bench.ts',
      'benchmarks/**/*.bench.client.ts',
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    disableConsoleIntercept: true,
  },
})
