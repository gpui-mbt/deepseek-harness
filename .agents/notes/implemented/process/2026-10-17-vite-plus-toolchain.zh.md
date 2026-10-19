# Agent Note: Run the repository toolchain through Vite+

Status: implemented

[English](2026-10-17-vite-plus-toolchain.md) | 中文

## Problem

本仓库原先用彼此独立的工具分别管理格式化、Lint、测试执行和打包：Oxlint 与 `@stylistic` 规则、Vitest 4、tsdown，以及 `package.json` 与 CI 中的临时命令。它们的版本各自漂移，同一个命令在脚本、钩子和工作流中出现了多种形式。Vite+ 1.3.0 同时提供 Vite、Vitest 5、Oxlint、Oxfmt 与 tsdown，因此仓库可以在保留包管理器和 TypeScript 构建图的前提下使用一套固定工具链。

## Decision

- `vite-plus` 1.3.0 是项目本地工具链。贡献者与 CI 通过 `pnpm exec vp` 或包脚本运行它；不需要全局安装 `vp`。
- pnpm 仍是包管理器，tsx 仍是脚本启动器。Vite+ 不替代 pnpm 的 workspace 设置，仓库的 Node.js engines 范围也不支持原生 TypeScript 剥离。
- Oxlint 配置位于 `scripts/lint-config.ts`，参与 Host TypeScript program，并由 `vite.config.ts` 导入供 `vp lint` 与 `vp check` 使用。`vite.staged.config.ts` 选择不加载类型信息的 profile；lefthook 继续负责钩子生命周期。
- Oxfmt 负责 TypeScript、JavaScript 及其配置文件的格式化。Markdown、YAML、CSS、HTML、JSON、vendor、native、生成文件和保留的 TypeGraph fixture 保持在外；这些格式由文档与 fixture 门禁负责。
- `vp test` 从既有 `vitest.*.config.ts` 运行 Vitest 5.0.5。每个配置都为 `vitest`、`@vitest/spy` 与 `vite-plus` 设置 `resolve.dedupe`，让 setup 文件与测试共享同一个 runner 模块图。
- 根 `vite` devDependency 别名指向 `@voidzero-dev/vite-plus-core` 1.3.0。`apps/web` 为应用构建保留 Vite 6，`website` 保留 Vite 5，因此 `vp` 命令从仓库根目录运行，且不安装 workspace 级的 `vite` override。
- 包脚本与 CI 调用 `vp test`；直接依赖 `vitest` 5.0.5 仍保留给会启动子进程的诊断脚本。已发布的 test-support harness 将 `vite-plus` 声明为 peer 并导入 `vite-plus/test`，使其声明与仓库共享同一 runner 标识。
- 自定义 host/client tsdown workspace 构建使用 `tsdown` 0.23.1，与 Vite+ 同捆的版本一致。`vp pack` 只读取 `vite.config.ts` 的 `pack` 块，会忽略 141 个包内 `tsdown.config.ts`；实测 `vp pack` 会构建包的默认 `src/index.ts`，而不是配置的入口。因此该构建继续使用 `tsdown`，直到包配置迁入 `pack` 块；其余工具链命令由 Vite+ 负责。

## Alternatives considered

- **所有命令都使用全局 `vp`。** 否决：CI 与贡献者会依赖 lockfile 之外的机器级安装和版本。
- **应用构建迁移到 `vp build`。** 否决：`apps/web` 与 VitePress 分别依赖 Vite 6 和 Vite 5；强制使用 Vite+ core 别名会在同一次改动中替换两条应用构建路径。
- **包管理迁移到 `vp install`。** 否决：workspace 依赖 pnpm 特有设置：overrides、`allowBuilds`、`minimumReleaseAgeExclude` 和 patched dependencies。
- **保留 Vitest 4，只用 Vite+ 做 Lint 与格式化。** 否决：`vp test` 提供 Vitest 5，仓库否则要维护两套 runner 约定。
- **把 141 个 `tsdown.config.ts` 全部改写成 `pack` 块。** 暂缓：两阶段构建在配置加载时通过 `DSH_BUILD_FACE` 选择入口与插件，静态 `pack` 块无法表达。
- **保留分裂的 Vitest 副本。** 否决：setup 文件与测试文件曾绑定到不同的 runner 模块图；`resolve.dedupe` 让两者看到同一个已安装 runner。

## Consequences

- 使用 Node 24.x 的贡献者需要 24.11 或更高版本才能运行 Vite+/Vitest 5 工具链。已发布包的 `engines` 范围不变，Node 24.9 兼容性 lane 仍需在 CI 中作为工具链例外验证。
- `apps/web` 与 `website` 保留各自的 Vite 副本。从这些目录运行 `vp` 会触发 Vite+ 的 core 版本检查，因此文档规定从仓库根目录运行 `vp`。
- test-support 包的发布依赖约定从 `vitest` 改为 `vite-plus` peer；消费方必须安装 Vite+ 才能使用其测试 harness。
- Oxfmt 格式化已应用到整个仓库。首次改动是机械性的，与行为变更分开。
- 在 `vp pack` 能在不丢失 host/client 构建 face 的情况下加载 workspace 配置之前，`tsdown` 命令例外继续存在；该依赖已与 Vite+ 同捆版本对齐。

## Verification

- `pnpm exec vp toolchain` 报告 Vite 8.3.4、Vitest 5.0.5、Oxlint 1.88.0、Oxfmt 0.73.0 与 tsdown 0.23.1。
- `pnpm run lint`、`pnpm run fmt:check`、`pnpm run typecheck`、`pnpm run test`、`pnpm run test:coverage`、`pnpm run build` 与 `pnpm run doc-sync` 覆盖迁移后的入口。
- `scripts/oxlint-contract.spec.ts` 的 Oxlint 契约测试证明 vp lint 包装器、staged profile、修复重试与 TypeScript 项目发现。
- unit、e2e、snapshot、expected-output 与 Web lane 覆盖各 Vitest 配置；jsdom 组件套件钉住去重后的 runner 模块图。
