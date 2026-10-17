import { defineConfig } from 'vite-plus'
import { stagedLintConfig } from './scripts/lint-config.ts'

/**
 * Fast pre-commit profile: the repository rules without type-aware analysis,
 * so the hook does not build the TypeScript programs.
 *
 * `vp lint -c` expects a Vite+ config, so this file exposes the staged Oxlint
 * object through the `lint` block.
 */
export default defineConfig({
  lint: stagedLintConfig,
})
