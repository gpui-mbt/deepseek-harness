# Agent Note: Adopt Vite+ for the test, lint, and pack toolchain

Status: implemented

English | [中文](2026-10-15-viteplus-toolchain-migration.zh.md)

## Problem

The repository ran its tests and lints from directly pinned tools — Vitest 4 across eight lane config files, Oxlint 1.81 read from `.oxlintrc.json` through a wrapper script, and tsdown 0.22 for library bundling — while Vite+ 1.2.0 bundles newer versions of all three behind one `vp` command surface. Staying on the standalone pins meant choosing between a version floor the toolchain had moved past and a second, permanently duplicated dependency set that could drift from the one Vite+ runs.

The tools need separate configuration owners. The coverage profile, its reporters, and its thresholds are root-only in Vitest 5, so they cannot live in a lane file. Library bundling needs ordered Host, Desktop, and Client passes, package-local entries, and programmatic builds; ordinary tests and lints must not import the built libraries that pack configuration loads.

## Decision

Run tests, lints, and library bundling through Vite+ 1.2.0 while keeping their configuration and lifecycle ownership separate.

- The root `vite.config.ts` owns what Vitest 5 keeps at the root — the lint block, the coverage profile with its per-file 100% thresholds, and the lane list — and points `vp test --project <lane>` at one config file per lane. `vitest.config.ts` becomes `vitest.unit.config.ts` because Vitest 5 discovers `vitest.config.*` before `vite.config.*`, and `vitest.web.perf.config.ts` becomes `vitest.web-perf.config.ts` because a project file's name allows no dot.
- Each lane keeps its own file inventory and setup files. Vitest 5 concatenates an inherited array with a project's own instead of replacing it, so a lane that also declared them at the parent level would run every setup file twice.
- `lint.config.ts` exports the Oxlint rules that `vp lint` runs and that `scripts/lint-rule-fingerprint.spec.ts` pins. Its rule list and order are the deleted `.oxlintrc.json` byte for byte, so every pinned fingerprint still holds. `check.fmt` stays off: `@stylistic` rules own formatting, and Oxfmt normalizes one-line arrow bodies in ways the repository's hand-maintained style does not.
- Tests and the contract spec import `vite-plus/test` so the runner and the suite share one mock and spy registry. `declare module 'vitest'` augmentations stay on the upstream module identity, and the one spec that augments it keeps importing `vitest`.
- `scripts/coverage-partitions.ts` keeps calling `vitest` directly with `--config`: it writes a generated config per partition, and `vp test` selects no config file.
- The root [`pack.config.ts`](../../../../pack.config.ts) dynamically discovers and sorts workspace members, evaluates each member's `pack.config.ts` for `DSH_BUILD_FACE`, and merges common defaults. Shared Client presets live in [`pack.client.ts`](../../../../packages/client/pack.client.ts). Host pack runs one workspace Typert plugin; Desktop bundles after Host and before Client, and Client never starts Typert.
- `tsx scripts/pack/run.ts host|client|desktop|bench|preview` selects a mode and owns its environment, then launches `vp -C scripts/pack pack` without a shell. Only [`scripts/pack/vite.config.ts`](../../../../scripts/pack/vite.config.ts) adapts these configs to Vite+'s `pack` block; the normal root [`vite.config.ts`](../../../../vite.config.ts) has no pack or built-library import. Configuration loading does not require Node's native TypeScript loader.
- Programmatic consumers import `build`, configs, and Rolldown types from the public `vite-plus/pack` entry and pass explicit configs. They own the returned `TsdownHandle` through completion and cleanup, including watch shutdown; no consumer reaches into Vite+'s private bundled files. The published Typert `./tsdown` plugin API and its source names remain unchanged.

The [Node engine floor](2026-07-06-node-engine-floor.md) moves to `^24.11.0` on the Node 24 line in the same change, because the toolchain declares `^22.18.0 || ^24.11.0 || >=26.0.0` and the compatibility matrix can no longer run below it.

## Consequences

- One Oxlint version exists in the tree. The standalone `oxlint`, `oxlint-tsgolint`, and the staged `.oxlintrc.staged.json` profile are gone; `scripts/run-oxlint.ts` spawns `vp lint` and keeps the repository worker budget, and the pre-commit hook runs it with `--no-type-aware` for speed.
- Vitest v5 defaults that would change test outcomes are pinned per lane with the comments the migration guidance requires: `clearMocks: false` (326 specs assert mock call counts) and `sharedViteServer: false` on the unit lane. `fakeTimers.toNotFake: ['Temporal']` is not needed — the two Temporal users import the polyfill as a module rather than reading a global.
- Every gate, workflow, and script that named a config file now names a project: `vp test --project unit*`, `--project e2e`, and so on. A root config that declares projects runs none of them itself, so an unqualified `vp test` would run every lane.
- The gate graph quotes a glob-shaped project filter in its printed command, because `pnpm exec vp test run --project unit*` would otherwise hand the shell a pattern.
- Existing build script names and the Host → Desktop → Client order remain stable. The root `vite` dependency is the npm alias `@voidzero-dev/vite-plus-core@1.2.0`; Web keeps Vite 6.4.3, the website keeps Vite 5.4.21, and Desktop keeps Vite 6. The Web preview command uses the pack runner; its normal Vite build is unchanged.
- The toolchain changes no product behavior or persistence schema. [The development guide](../../../../docs/development.md#toolchain-configuration) owns current contributor commands and configuration.

## Alternatives considered

- **Run `vp migrate` and adopt its output wholesale.** Rejected: it reformatted every source and test file with Oxfmt, including 2,110 spec files, which contradicts the `@stylistic` rules and turns every upstream merge into a reformat conflict. Its semantic changes were re-applied by hand instead; the full output stayed in a stash while that work ran.
- **Keep `.oxlintrc.json` and let `vp lint` discover it.** Rejected on inspection, not preference: `vp lint` does read Oxlint's native config discovery, but the toolchain's own migration moves the rules into the `lint` block, and keeping two homes for one rule set invites drift.
- **Put every lane inline in the root config so the lanes inherit the lint and compatibility settings.** Rejected: it inlines roughly 600 lines of lane configuration into one file, and the per-lane files are what a reader compares when a lane's inventory changes.
- **Put the pack block in the normal root Vite config.** Rejected: its member configs import built generator code and package-local build helpers, making ordinary tests and lints depend on build outputs and execute unrelated build-time imports. The dedicated adapter keeps that dependency in pack commands.
- **Keep standalone tsdown or use Vite+'s private bundled API.** Standalone pins duplicate the engine Vite+ owns; private imports couple consumers to its installation layout. The public `vite-plus/pack` API supplies explicit configs and build handles without requiring a native config loader.
- **Adopt Oxfmt now and drop the `@stylistic` rules.** Rejected: the same whole-tree reformat, without a formatting story the maintainers chose.
- **Leave the Node 24 branch at `>=24.0.0`.** Rejected: the advertised range would cover runtimes that cannot run the toolchain, and the matrix would lose the ability to hold a v1-loader leg at all.

## Known gaps

- Oxlint 1.88 drops `off` suppressions for type-aware rules from one override once a JS plugin is loaded, so the TypeGraph fixture's `no-explicit-any` override cannot apply in any configuration of ours. `scripts/oxlint-contract.spec.ts` pins the fixture's exclusion from the lint profile instead of its project-free syntax pass, and the gap closes when upstream fixes the merge.
- `vp lint` prints one note to stderr because the repository has an `npm run lint` script that shadows the built-in command. Renaming that script would remove the note but change a documented command everywhere.