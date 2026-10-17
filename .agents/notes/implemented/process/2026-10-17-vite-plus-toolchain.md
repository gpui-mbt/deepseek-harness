# Agent Note: Run the repository toolchain through Vite+

Status: implemented

English | [中文](2026-10-17-vite-plus-toolchain.zh.md)

## Problem

Formatting, linting, test execution, and bundling were configured through separate tools: Oxlint and `@stylistic` rules, Vitest 4, tsdown, and ad-hoc commands in `package.json` and CI. Their versions drifted independently, and the same command appeared in several forms across scripts, hooks, and workflows. Vite+ 1.3.0 bundles Vite, Vitest 5, Oxlint, Oxfmt, and tsdown, so the repository can use one pinned toolchain while keeping its package manager and TypeScript build graph.

## Decision

- `vite-plus` 1.3.0 is the project-local toolchain. Contributors and CI run it through `pnpm exec vp` or the package scripts; no global `vp` installation is required.
- pnpm remains the package manager and tsx remains the script launcher. Vite+ does not replace pnpm's workspace settings, and the repository's Node.js engines range excludes native TypeScript stripping.
- The Oxlint configuration lives in `scripts/lint-config.ts`, participates in the Host TypeScript program, and is imported by `vite.config.ts` for `vp lint` and `vp check`. `vite.staged.config.ts` selects the non-type-aware profile; lefthook continues to own the hook lifecycle.
- Oxfmt owns code formatting for TypeScript, JavaScript, and their config files. Markdown, YAML, CSS, HTML, JSON, vendored code, native code, generated files, and the preserved TypeGraph fixture remain outside it; the documentation and fixture gates own those formats.
- `vp test` runs Vitest 5.0.5 from the existing `vitest.*.config.ts` files. Every configuration sets `resolve.dedupe` for `vitest`, `@vitest/spy`, and `vite-plus` so setup files and tests share one runner module graph.
- The root `vite` devDependency is aliased to `@voidzero-dev/vite-plus-core` 1.3.0. `apps/web` keeps Vite 6 and `website` keeps Vite 5 for their application builds, so `vp` commands run from the repository root and no workspace-wide `vite` override is installed.
- Package scripts and CI invoke `vp test`; a direct `vitest` 5.0.5 dependency remains for process-spawning diagnostics. The published test-support harnesses declare `vite-plus` as a peer and import `vite-plus/test`, so their declarations share the repository's runner identity.
- The custom host/client tsdown workspace build remains on `tsdown` while `vp pack` cannot load the 141 package-local `tsdown.config.ts` files and the environment-selected root config. Vite+ owns the other toolchain commands; `tsdown` remains on 0.22.2 for that build until `vp pack` can load the workspace configuration.

## Alternatives considered

- **Use the global `vp` binary for every command.** Rejected because CI and contributors would depend on a machine-level installation and version outside the lockfile.
- **Move app builds to `vp build`.** Rejected because `apps/web` and VitePress depend on Vite 6 and Vite 5 respectively; forcing the Vite+ core alias would replace both application builds in the same change.
- **Move package management to `vp install`.** Rejected because the workspace relies on pnpm-specific settings: overrides, `allowBuilds`, `minimumReleaseAgeExclude`, and patched dependencies.
- **Keep Vitest 4 and use Vite+ only for linting and formatting.** Rejected because `vp test` supplies Vitest 5 and the repository would otherwise carry two runner contracts.
- **Rewrite all 141 `tsdown.config.ts` files into `pack` blocks.** Deferred because the two-pass build selects entries and plugins from `DSH_BUILD_FACE` at config load, which the static `pack` block does not express.
- **Keep the split Vitest copies.** Rejected after setup files and test files bound to different runner module graphs; `resolve.dedupe` makes the single installed runner visible to both.

## Consequences

- Node 24.x contributors need 24.11 or newer for the Vite+/Vitest 5 toolchain. The published package `engines` range is unchanged, and the Node 24.9 compatibility lane remains a toolchain exception to validate in CI.
- `apps/web` and `website` retain their own Vite copies. Running `vp` from those directories would hit Vite+'s core-version check, so the documented workflow runs `vp` from the repository root.
- The test-support packages changed their published dependency contract from `vitest` to a `vite-plus` peer; consumers must install Vite+ to use their test harnesses.
- Oxfmt formatting is applied across the repository. The initial change is mechanical and separate from behavior changes.
- The `tsdown` exception remains until `vp pack` can load the workspace configuration without losing the host/client build faces.

## Verification

- `pnpm exec vp toolchain` reports Vite 8.3.4, Vitest 5.0.5, Oxlint 1.88.0, Oxfmt 0.73.0, and tsdown 0.23.1.
- `pnpm run lint`, `pnpm run fmt:check`, `pnpm run typecheck`, `pnpm run test`, `pnpm run test:coverage`, `pnpm run build`, and `pnpm run doc-sync` cover the migrated surfaces.
- Oxlint contract tests in `scripts/oxlint-contract.spec.ts` prove the vp lint wrapper, staged profile, fix retries, and TypeScript project discovery.
- Vitest configurations are exercised by the unit, e2e, snapshot, expected-output, and Web lanes; the jsdom component suites pin the deduped runner graph.
