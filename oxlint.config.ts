/**
 * Stable entry point for the repository Oxlint configuration. The object lives
 * in `scripts/lint-config.ts` so it participates in the Host TypeScript program
 * and its rule fingerprint test; this file keeps the Vite+ config import and
 * the conventional Oxlint config name together.
 */
export { default, stagedLintConfig } from './scripts/lint-config.ts'
