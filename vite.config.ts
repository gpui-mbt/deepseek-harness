import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import { lint } from './lint.config.ts'
import { resolvePwshPath } from './packages/shell/pwsh-local/src/resolve.ts'
import { windowsUnsupportedPackages } from './vitest.shared.ts'
import { COVERAGE_PARTITION_MODE_ENV } from './scripts/coverage-partitions.ts'

// Prints exact `path:line:col` records for every uncovered statement, branch
// path, and function when a file misses the per-file 100% gate — the built-in
// threshold ERRORs name only the file. Absolute path because istanbul-reports
// require()s custom reporters (which is also why the reporter is CJS).
const uncoveredLocationsReporter = fileURLToPath(new URL('./scripts/coverage-uncovered-locations.cjs', import.meta.url))

const coveragePartitionRaw = process.env[COVERAGE_PARTITION_MODE_ENV]
if (coveragePartitionRaw !== undefined && coveragePartitionRaw !== '' && coveragePartitionRaw !== '1') {
  throw new Error(`vite config: ${COVERAGE_PARTITION_MODE_ENV} must be '1' or unset, got ${JSON.stringify(coveragePartitionRaw)}.`)
}
const coveragePartitionMode = coveragePartitionRaw === '1'


// Package globs the Windows coverage lane cannot instrument.
const windowsUnsupportedCoveragePackages = process.platform === 'win32'
  ? [...windowsUnsupportedPackages, 'packages/subprocess/*']
  : []

// Windows-only packages: their sources execute exclusively on win32 (koffi
// loads Win32 libraries), so the Linux coverage lane can never cover them.
// The Windows dev/CI lane exercises them through the probe/runner suites; the
// per-file 100% gate must not fail on their Linux-uncovered paths.
const windowsOnlyCoverageExclusions = process.platform !== 'win32'
  ? [
      'packages/sandbox/sandbox-windows-acl/src/**/*.ts',
      // The koffi-backed Win32 table (Toolhelp32/GetProcessTimes/taskkill)
      // executes only on win32; its decision logic is unit-pinned on every
      // host through the injected-internals suites.
      'packages/subprocess/subprocess-local/src/windows-inspector.ts',
    ]
  : []

// The confinement runner entry executes exclusively as a spawned child
// process (the sandbox seam's argv-prefix wrapper): its module-level main()
// would run the confinement in-process if imported, and vitest's v8 coverage
// never measures child processes. Its behavior is pinned end-to-end by
// tests/runner.spec.ts, which spawns the real entry through tsx.
const windowsRunnerCoverageExclusions = process.platform === 'win32'
  ? [
      'packages/sandbox/sandbox-windows-acl/src/runner.ts',
      // The session write lock's POSIX face (fs-ext flock plus inode
      // verification) executes only off-Windows: the Linux lanes hold its
      // per-file 100%, while the Windows branch is unit-pinned by
      // win32.spec's injected bindings and exercised natively by every
      // Windows suite through the real backend.
      'packages/session/session-persistence-jsonl/src/lease.ts',
      // The macOS provider transport uses Unix sockets; POSIX lanes cover its real socket lifecycle.
      'packages/experimental/cua-macos/src/shared-native.ts',
    ]
  : []

// pwsh-local's run/start/lifecycle suites self-skip without a real pwsh
// (executor.spec.ts hasPwsh), leaving this file
// far below per-file 100% on pwsh-less hosts; the exemption keeps those hosts
// green while CI runners ship pwsh and still enforce the full bar. The probe
// runs the suites' own resolution (the dependency-free resolve.ts module),
// so the exemption is active exactly when the suites skip — a mismatched
// narrower probe could exempt the file on hosts whose suites actually run.
const pwshCoverageExclusions = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0
  ? []
  : [
      'packages/shell/pwsh-local/src/index.ts',
      'packages/shell/pwsh-sandbox/src/**/*.ts',
    ]
export default defineConfig({
  lint,
  check: {
    // Oxfmt is not the repository's formatter. Style stays owned by the
    // `@stylistic` lint rules below, and `vp check` therefore skips its
    // formatting step rather than reformatting every source file.
    fmt: false,
  },
  test: {
    // Each lane keeps its own config file: `vp test` selects them by project
    // name (`--project`), and the root config owns what Vitest 5 keeps
    // root-only — coverage collection, its reporters, and its thresholds.
    projects: [
      './vitest.unit.config.ts',
      './vitest.e2e.config.ts',
      './vitest.expected.config.ts',
      './vitest.snapshot.config.ts',
      './vitest.web.config.ts',
      './vitest.web-perf.config.ts',
      './vitest.web-stress.config.ts',
      './vitest.bench.config.ts',
    ],
    coverage: {
      provider: 'v8',
      // Coverage measures OUR runtime source. Types-only files carry no
      // executable code; vendor/ and application/config fixtures are out of scope.
      // .tsx: client components are gated like everything else (jsdom lane).
      include: ['packages/*/*/src/**/*.{ts,tsx}'],
      // Types-only files have no runtime coverage. Importing self-executing bins/workers would boot
      // them inside the unit process, so real subprocess/Worker tests cover their thin entry glue.
      exclude: [
        'packages/*/*/src/types.ts',
        'packages/*/*/src/bin.ts',
        'packages/*/*/src/worker.ts',
        // The built Node entry invokes the independently covered process bootstrap through fd 7.
        'packages/ptc-runtime/ptc-runtime-node/src/process-entry.ts',
        'packages/ptc-runtime/ptc-runtime-node/src/persistent-process-entry.ts',
        // Dynamic Host/Client composition is covered by its focused lifecycle
        // tests and assembled application checks rather than per-file coverage.
        'packages/self-modification/*/src/**/*.{ts,tsx}',
        // A killed executable lint-contract test can leave a non-product source probe behind.
        'packages/*/*/src/oxlint-contract-*.ts',
        // Client/web UI files whose remaining branches need a browser-grade
        // harness the jsdom lane doesn't cover yet. TODO(gui): cover and
        // remove as the client test lane matures.
        'packages/client/ui-trajectory/src/*',
        // Electron guest integration retains its unit specs; per-file coverage
        // is deferred until a native Electron harness covers guest behavior.
        'packages/client/ui-sidebar-browser/src/client/electron/**',
        // Trajectory's compact Markdown projection retains deferred branch coverage.
        'packages/client/ui-primitives/src/markdown/plain-text.ts',
        'packages/client/ui-user-questions/src/client/QuestionComposer.tsx',
        'packages/client/ui-primitives/src/Menu.tsx',
        'packages/client/ui-primitives/src/RiskConfirmation.tsx',
        'packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx',
        'packages/client/ui-workspace/src/client/WorkspacePicker.tsx',
        'packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx',
        'packages/client/ui-renderer/src/client/*',
        // Session object internals retain the runtime GUI debt exemption; the
        // assistant-stream reconciler, Controller entry, transport, Agent scope,
        // and adapters stay gated.
        'packages/api/session-controller/src/client/sessions/!(assistant-stream).ts',
        'packages/api/session-controller/src/client/ordered-baseline.ts',
        'packages/api/session-controller/src/client/time-zone.ts',
        // Keep the browser conversation tree under its existing GUI debt
        // exemption while gating the newly stateful Host half and vocabulary.
        'packages/client/ui-conversation/src/client/*',
        // Chat presentation and assembly retain the same GUI debt exemption;
        // package wiring and the new approval-detail adapter remain gated.
        'packages/client/ui-chat/src/client/chat/!(ApprovalCommand).{ts,tsx}',
        'packages/client/ui-chat/src/client/conversation-nodes/*',
        'packages/client/ui-chat/src/client/details/*',
        'packages/client/ui-chat/src/client/model/*',
        'packages/client/ui-chat/src/client/contract/snapshot.ts',
        'packages/client/ui-chat/src/client/historical-images.ts',
        'packages/client/ui-primitives/src/DisclosureRow.tsx',
        'packages/client/ui-tool/src/*',
        'packages/client/ui-slots/src/*',
        'packages/client/ui-layout/src/*',
        'packages/client/web/src/*',
        'packages/host/webserver/src/*',
        // The browser-worker runtime and its image packer: the executing
        // composition is a real dedicated Worker driven by the web browser lane
        // (apps/web/tests/preview-boot.e2e.ts), which unit-process V8 coverage
        // cannot observe. Unit specs cover the algorithmic cores; the assembled
        // evidence is that boot. TODO(webworker): revisit when a browser-grade
        // coverage lane exists.
        'packages/experimental/webworker-runtime/src/**',
        'packages/experimental/webworker-packer/src/*',
        // Inspector execution adapters run in a Node Worker, the Host native
        // inspector session, or a browser realm, outside attributable parent
        // Vitest coverage.
        'packages/experimental/inspector/src/client/**',
        'packages/experimental/inspector/src/host/bridge/**',
        'packages/experimental/inspector/src/host/cdp/**',
        'packages/experimental/inspector/src/worker/bridge/**',
        'packages/experimental/inspector/src/worker/cdp/**',
        'packages/experimental/inspector/src/worker/realms/**',
        'packages/experimental/inspector/src/worker/{entry,server}.ts',
        // Keep already-complete Inspector modules under the per-file gate and
        // enumerate the remaining direct-test debt instead of exempting src/**.
        // TODO(inspector): close these branch gaps and remove the entries.
        'packages/experimental/inspector/src/shared/bridge/{control-codec,rpc}.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/observation.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/query/codec.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/runtime/{command-codec,console-frames,frames,value-codec}.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/sources/{codec,frames}.ts',
        'packages/experimental/inspector/src/worker/inspection/{cordis-store,query-router,realm-store}.ts',
        // Web config-tree boot round: the new host-side web-transport halves
        // whose remaining branches need real-composition/process harnesses.
        // TODO(gui): cover and remove with the client test lane above.
        'packages/client/modules/src/index.ts',
        'packages/client/modules/src/client/index.ts',
        'packages/client/modules/src/client/manifest.ts',
        'packages/client/hmr/src/index.ts',
        'packages/client/connection/src/index.ts',
        'packages/client/connection/src/http-bridge.ts',
        // This assembly imports generated Host-for-Client code that exists
        // only in lib; the post-build built-bin smoke executes both entries.
        'packages/api/remotes/src/index.ts',
        'packages/api/remotes/src/client/index.ts',
        // The Team browser entry binds its source-covered mount lifecycle to
        // the generated Team Remote contribution, which likewise exists only in lib.
        'packages/experimental/client-ui-agent-team/src/client/index.ts',
        // The speech entry also imports generated Remote definitions; voice-input.e2e.ts
        // exercises the built entry, while source tests cover mountVoiceInput.
        'packages/experimental/client-ui-voice-input/src/client/index.ts',
        // The mods band entry imports the bridge's generated Remote contribution, which exists only in lib;
        // the Web snapshot exercises the built entry, while source tests cover mountModsBand.
        'packages/experimental/client-ui-claude-code-mods/src/client/index.ts',
        // The access entry imports its generated Remote contribution, which exists only in lib;
        // the Web snapshot exercises the built entry, while source tests cover mountAccess.
        'packages/api/remote-access/src/client/index.ts',
        // Slash/command/input round: per-file gaps deferred with the same
        // client-lane debt. TODO(gui): cover and remove with the lane above.
        'packages/client/ui-commands/src/index.ts',
        'packages/client/ui-skill/src/index.ts',
        'packages/client/ui-input-trigger/src/index.ts',
        'packages/client/ui-subagent/src/index.ts',
        'packages/client/ui-commands/src/client/popup.ts',
        'packages/client/ui-commands/src/client/directory.ts',
        'packages/client/ui-commands/src/client/service.ts',
        'packages/client/ui-commands/src/client/PopupSelectView.tsx',
        'packages/client/ui-model-selection/src/index.ts',
        'packages/client/ui-permission-presets/src/index.ts',
        'packages/client/ui-model-selection/src/client/ModelSelect.tsx',
        'packages/client/ui-model-selection/src/client/directory.ts',
        'packages/client/ui-model-selection/src/client/index.ts',
        'packages/client/ui-model-selection/src/client/service.ts',
        'packages/client/ui-input-trigger/src/client/controller.ts',
        'packages/client/ui-input-trigger/src/client/service.ts',
        'packages/client/ui-input-trigger/src/core/menu.ts',
        'packages/client/ui-input-trigger/src/core/detect.ts',
        'packages/client/ui-sidebar/src/client/index.ts',
        'packages/client/ui-skill/src/client/index.ts',
        'packages/client/ui-workspace/src/client/index.ts',
        'packages/test-support/client-runtime/src/translate.ts',
        'packages/client/ui-primitives/src/JsonTree.tsx',
        'packages/client/ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx',
        'packages/client/ui-settings-models/src/client/welcome-store.ts',
        'packages/extensions/*/src/**/*.ts',
        'packages/extensions/*/src/**/*.tsx',
        // Typert correctness is checked by its uninstrumented suites,
        // including compiler fixtures and byte-for-byte catalog reproduction.
        'packages/typert/*/src/**/*.{ts,tsx}',
        // Experimental webworker-runtime is outside the coverage requirement
        // by decision: its correctness signal is its uninstrumented suite and
        // the packer's end-to-end image spec.
        'packages/experimental/webworker-runtime/src/**/*.ts',
        // Projection/command round: executor lifecycle branches and the
        // registry's drive tails need the same maturing lanes. TODO(gui):
        // cover and remove with the client test lane above.
        'packages/interaction/commands/src/index.ts',
        'packages/session/session-projection/src/index.ts',
        ...windowsUnsupportedCoveragePackages.map(path => `${path}/src/**/*.ts`),
        ...windowsOnlyCoverageExclusions,
        ...windowsRunnerCoverageExclusions,
        ...pwshCoverageExclusions,
      ],
      // 100% or it doesn't merge (docs/testing.md: excessive tests are welcome).
      // Per-file so a well-covered big file can't subsidize a bare one.
      // Every v8 ignore comment must carry a reason — see the testing policy
      // (docs/testing.md).
      thresholds: coveragePartitionMode
        ? undefined
        : {
            perFile: true,
            statements: 100,
            branches: 100,
            functions: 100,
            lines: 100,
          },
      reporter: coveragePartitionMode
        ? []
        : process.env.CI
          ? ['text', uncoveredLocationsReporter]
          : ['text', 'html', uncoveredLocationsReporter],
    },
  },
})
