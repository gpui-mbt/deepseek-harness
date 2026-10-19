import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite-plus'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/** Opt-in browser performance lane; no default Vitest config includes *.stress.ts. */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  resolve: { dedupe: ['vitest', '@vitest/spy', 'vite-plus'] },
  test: {
    // Preserve Vitest 4 mock-history behavior for setup and cross-test calls.
    clearMocks: false,
    execArgv: vitestExecArgv,
    include: ['apps/web/stress-tests/**/*.stress.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
