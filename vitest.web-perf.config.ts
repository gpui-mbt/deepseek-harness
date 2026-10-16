import { defineConfig } from 'vite-plus'
import webConfig from './vitest.web.config.ts'
import { vitestExecArgv } from './vitest.shared.ts'

// Manual high-cardinality diagnostics stay outside every default Vitest
// inventory and therefore outside CI's executed test lanes.
export default defineConfig({
  ...webConfig,
  test: {
    ...webConfig.test,
    // The spread above copies the web lane's name and its mock-history
    // compatibility; this lane's own identity comes after it.
    name: 'web-perf',
    // Memory diagnostics use forced-GC baselines only in this manual inventory.
    execArgv: [...vitestExecArgv, '--expose-gc'],
    include: [
      'apps/web/tests/**/*.perf.ts',
      'packages/client/ui-conversation/tests/**/*.perf.client.ts',
    ],
    disableConsoleIntercept: true,
    hookTimeout: 180_000,
    testTimeout: 600_000,
  },
})
