import { defineConfig } from 'vite-plus'
import lintConfig from './oxlint.config.ts'

/**
 * Repository-wide Vite+ configuration. `vp check` runs Oxfmt and the Oxlint
 * configuration below; `pnpm run typecheck` remains the authoritative
 * TypeScript gate because it checks both aggregate programs against their
 * generated package declarations.
 */
export default defineConfig({
  lint: lintConfig,
  fmt: {
    semi: false,
    singleQuote: true,
    arrowParens: 'avoid',
    trailingComma: 'all',
    bracketSpacing: true,
    printWidth: 140,
    proseWrap: 'preserve',
    sortPackageJson: false,
    ignorePatterns: [
      '**/lib/**',
      '**/node_modules/**',
      '**/.sessions/**',
      '.claude/**',
      '**/.doc-typecheck-*/**',
      '**/.node-next-types-*/**',
      'website/.generated/**',
      'vendor/**',
      'native/**',
      '**/*.md',
      '**/*.mdx',
      '**/*.yml',
      '**/*.yaml',
      '**/*.vue',
      '**/*.json',
      '**/*.css',
      '**/*.html',
      '**/*.toml',
      '**/*.generated.ts',
      '**/*.generated.*',
      '**/generated.ts',
      'packages/workflow/workflow-ptc/src/guest-source.ts',
      'packages/extensions/cordis-client-runner/src/client/api-catalog.ts',
      'packages/extensions/tool-cordis/src/api-catalog.ts',
      'packages/client/tsdown.client.ts',
      'scripts/gen-third-party-notices.ts',
      'packages/extensions/cordis-client-runner/src/client/slot-catalog.ts',
      'packages/core/session/src/known-event-types.ts',
      'website/tests/expected/**',
      'pnpm-lock.yaml',
      'packages/typert/generator/tests/fixtures/type-model/**',
      'packages/experimental/claude-code-mods/examples/**',
    ],
  },
})
