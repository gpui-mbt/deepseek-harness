/**
 * Generate the project-free Oxlint profile the pre-commit hook lints with.
 *
 * `vp lint` cannot disable type-aware rules from the command line, and a
 * type-aware pass needs a TypeScript program per staged file — too slow for a
 * pre-commit checkpoint. The profile is generated from `lint.config.ts` into the
 * repository root so its JavaScript plugins resolve, and removed afterwards.
 * @module scripts/staged-lint-config
 */
import { rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { lint } from '../lint.config.ts'

/** Path of the generated profile; `vp lint --config` reads it. */
export const stagedLintConfigPath = fileURLToPath(new URL('../.oxlintrc.staged.json', import.meta.url))

/**
 * Serialize the repository rules with type-aware analysis switched off.
 * @returns The config path to pass to `vp lint --config`.
 */
export function writeStagedLintConfig(): string {
  writeFileSync(stagedLintConfigPath, `${JSON.stringify(stagedLintConfig(), undefined, 2)}\n`)
  return stagedLintConfigPath
}

/** Delete the generated profile; a missing file is already the wanted state. */
export function removeStagedLintConfig(): void {
  rmSync(stagedLintConfigPath, { force: true })
}

/**
 * The staged profile itself: every repository rule, without type-aware analysis.
 * @returns A plain Oxlint configuration object.
 */
export function stagedLintConfig(): unknown {
  return { ...lint, options: { ...lint.options, typeAware: false } }
}
