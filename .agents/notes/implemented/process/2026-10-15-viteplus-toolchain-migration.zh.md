# Agent Note: 采用 Vite+ 作为测试、静态检查与打包工具链

Status: implemented

[English](2026-10-15-viteplus-toolchain-migration.md) | 中文

## 问题

仓库此前用直接固定版本的工具运行测试与静态检查——Vitest 4 配 8 个通道配置文件、Oxlint 1.81 通过包装脚本读取 `.oxlintrc.json`、库打包用 tsdown 0.22——而 Vite+ 1.2.0 把三者的更新版本统一捆绑在 `vp` 命令之下。继续固定旧版本意味着：要么接受一个工具链已经走过的版本下限，要么长期维护一份可能与 Vite+ 实际运行版本漂移的重复依赖。

这些工具需要各自的配置归属。在 Vitest 5 中，覆盖率配置、其 reporter 与阈值只能位于根层，因此无法留在通道配置文件里。库打包需要有序的 Host、Desktop 与 Client 阶段、包内入口及编程构建；普通测试与静态检查不能导入 pack 配置所加载的已构建库。

## 决策

测试、静态检查与库打包都通过 Vite+ 1.2.0 运行，同时分离各自的配置与生命周期归属。

- 根 `vite.config.ts` 持有 Vitest 5 仅保留在根层的内容——lint 配置块、含按文件 100% 阈值的覆盖率配置与通道列表——并通过 `vp test --project <lane>` 指向每个通道各自的配置文件。`vitest.config.ts` 更名为 `vitest.unit.config.ts`，因为 Vitest 5 先于 `vite.config.*` 查找 `vitest.config.*`；`vitest.web.perf.config.ts` 更名为 `vitest.web-perf.config.ts`，因为项目文件名不允许出现点号。
- 每个通道各自持有文件清单与 setup 文件。Vitest 5 会把继承得到的数组与通道自身的数组拼接而非替换，若通道同时在父层声明，setup 文件会执行两次。
- `lint.config.ts` 导出 `vp lint` 运行、`scripts/lint-rule-fingerprint.spec.ts` 固定的 Oxlint 规则。其规则列表与顺序与被删除的 `.oxlintrc.json` 逐字节一致，因此所有已固定的指纹仍然成立。`check.fmt` 保持关闭：格式由 `@stylistic` 规则负责，而 Oxfmt 对单行 arrow 函数体的归一化方式与仓库手工维护的风格不符。
- 测试与契约 spec 从 `vite-plus/test` 导入，使运行器与测试套件共用同一份 mock 与 spy 注册表。`declare module 'vitest'` 增强保持上游模块标识，进行增强的那一个 spec 仍从 `vitest` 导入。
- `scripts/coverage-partitions.ts` 继续直接调用 `vitest` 并使用 `--config`：它为每个分片生成配置文件，而 `vp test` 不选择配置文件。
- 根 [`pack.config.ts`](../../../../pack.config.ts) 动态发现并排序 workspace 成员，按 `DSH_BUILD_FACE` 求值各成员的 `pack.config.ts`，并合并公共默认值。共享 Client 预设位于 [`pack.client.ts`](../../../../packages/client/pack.client.ts)。Host pack 运行一个 workspace Typert 插件；Desktop 在 Host 之后、Client 之前打包，Client 从不启动 Typert。
- `tsx scripts/pack/run.ts host|client|desktop|bench|preview` 选择模式并拥有其环境，随后不经 shell 启动 `vp -C scripts/pack pack`。只有 [`scripts/pack/vite.config.ts`](../../../../scripts/pack/vite.config.ts) 将这些配置适配到 Vite+ 的 `pack` 配置块；普通根 [`vite.config.ts`](../../../../vite.config.ts) 不导入 pack 或已构建库。配置加载不要求 Node 的原生 TypeScript 加载器。
- 编程调用方从公开的 `vite-plus/pack` 入口导入 `build`、配置与 Rolldown 类型，并传入显式配置。调用方拥有返回的 `TsdownHandle`，负责完成与清理，包括停止 watch；没有调用方读取 Vite+ 的私有捆绑文件。已发布的 Typert `./tsdown` 插件 API 及其源码名称保持不变。

[Node 引擎下限](2026-07-06-node-engine-floor.zh.md) 在同一变更中把 Node 24 线改为 `^24.11.0`，因为工具链声明 `^22.18.0 || ^24.11.0 || >=26.0.0`，兼容性矩阵也无法再在其下运行。

## 后果

- 树中只剩一个 Oxlint 版本。独立的 `oxlint`、`oxlint-tsgolint` 以及暂存用的 `.oxlintrc.staged.json` 配置均已移除；`scripts/run-oxlint.ts` 改为启动 `vp lint` 并保留仓库的 worker 预算，pre-commit 钩子以 `--no-type-aware` 运行它以保证速度。
- 会改变测试结果的 Vitest v5 默认值，按迁移指引的要求逐通道固定并附注释：`clearMocks: false`（326 个 spec 断言 mock 调用次数）以及单元通道的 `sharedViteServer: false`。无需 `fakeTimers.toNotFake: ['Temporal']`：使用 Temporal 的两处是以模块方式导入 polyfill，而非读取全局。
- 每个门禁、工作流与脚本中指名配置文件的命令改为指名项目：`vp test --project unit*`、`--project e2e` 等。声明了 projects 的根配置自身不运行任何通道，因此不带限定的 `vp test` 会运行全部通道。
- 门禁图对形如通配符的项目过滤参数加引号，因为 `pnpm exec vp test run --project unit*` 否则会把模式交给 shell 展开。
- 现有构建脚本名称与 Host → Desktop → Client 顺序保持稳定。根 `vite` 依赖是 npm 别名 `@voidzero-dev/vite-plus-core@1.2.0`；Web 保持 Vite 6.4.3，website 保持 Vite 5.4.21，Desktop 保持 Vite 6。Web 预览命令使用 pack 运行器，普通 Vite 构建不变。
- 工具链不改变产品行为或持久化 schema。[开发指南](../../../../docs/development.zh.md#toolchain-configuration)负责当前贡献者命令与配置。

## 曾考虑的替代方案

- **直接运行 `vp migrate` 并全盘采用其输出。** 已否决：它用 Oxfmt 重新格式化了全部源码与测试文件（含 2,110 个 spec），这与 `@stylistic` 规则冲突，也会让每次上游合并都变成格式化冲突。其语义变更是手工重新应用的；在该工作进行期间，完整输出保存在 stash 中。
- **保留 `.oxlintrc.json` 并让 `vp lint` 自行发现。** 否决理由基于实测而非偏好：`vp lint` 确实使用 Oxlint 的原生配置发现，但工具链自身的迁移会把规则移入 `lint` 配置块，为同一套规则保留两个归属只会招致漂移。
- **把所有通道内联进根配置，使其继承 lint 与兼容性设置。** 已否决：这会把约 600 行通道配置内联进单个文件，而通道各文件正是读者在对比通道清单变化时要看的东西。
- **把 pack 配置块放进普通根 Vite 配置。** 已否决：成员配置会导入已构建的 generator 代码与包内构建辅助模块，导致普通测试与静态检查依赖构建产物，并执行无关的构建期导入。专用适配器将该依赖保留在 pack 命令中。
- **保留独立 tsdown，或使用 Vite+ 的私有捆绑 API。** 独立固定版本会重复引入 Vite+ 拥有的引擎；私有导入会将调用方耦合到安装布局。公开的 `vite-plus/pack` API 提供显式配置与构建句柄，无需原生配置加载器。
- **现在采用 Oxfmt 并去掉 `@stylistic` 规则。** 已否决：同样是全树重新格式化，且没有维护者选择的格式化故事。
- **保持 Node 24 分支为 `>=24.0.0`。** 已否决：所宣传的范围会覆盖无法运行工具链的运行时，兼容性矩阵也将完全无法保留 v1-loader 分支。

## 已知缺口

- Oxlint 1.88 在配置加载 JS 插件后，会丢弃其他 override 中对类型感知规则的 `off` 抑制，因此 TypeGraph fixture 的 `no-explicit-any` override 无法在我们任何配置下生效。`scripts/oxlint-contract.spec.ts` 改为固定该 fixture 被排除在 lint 配置之外，而非固定其免类型分析的语法检查；待上游修复合并逻辑后即可闭合。
- 由于仓库存在与内建命令同名的 `npm run lint` 脚本，`vp lint` 会在 stderr 打印一条提示。重命名该脚本可以去掉提示，但要在各处改动一个已成文的命令。