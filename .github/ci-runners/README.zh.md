# CI 运行器默认值

[English](README.md) | 中文

## Fork CI 运行器

此 fork 的六个静态检查、覆盖率、快照/产物及原生 Windows 作业默认使用 GitHub 托管的 `ubuntu-24.04` 与 `windows-2025`。显式故障转移变量保留按需启用的语义，不修改仓库设置或权限。托管 gate 并发为一，覆盖率使用两个 worker 与两个分区，快照 worker 上限为二。这些只是资源预算，不是测试过滤：原有命令、平台矩阵、覆盖率阈值、快照及最终结论依赖均保持不变。Windows 覆盖率与继承的工作流一样保留为独立结果。仍须真实 CI 验证，运行器可用不代表检查成功。

实现位于 [ci.yml](../workflows/ci.yml)；[ci-hosted-runners.spec.ts](../../scripts/ci-hosted-runners.spec.ts) 检查运行器解析与必需 gate 的保留。
