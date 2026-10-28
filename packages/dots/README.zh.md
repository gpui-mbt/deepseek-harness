---
description: "dots 包组：拥有独立工作区、主会话、记忆与调度的持久命名代理。"
kind: "package-group"
---

# dots/ — 持久命名代理

[English](README.md) | 中文

## 概述

dot 是用于跨越多次任务持续工作的持久命名代理。每个 dot 拥有工作区目录、跨重启存活的主会话、受管的 `AGENTS.md` 契约、有上限的 `MEMORY.md`、执行期工具白名单以及持久调度。当某个代理需要长期承担责任时使用本包组；单轮工作用普通会话更省资源。本包组提供一个宿主服务、一个 Typert Remote 命名空间以及六个面向模型的工具，不包含多宿主路由。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`dots/`](dots/README.zh.md) | 持久 dot 记录、主会话生命周期、派发投递、存储域持久化以及 `dotsController` Remote 服务 |
| [`tool-dots/`](tool-dots/README.zh.md) | 基于 `ctx.dotsController` 的 preset 级 `dot_create`、`dot_list`、`dot_assign`、`dot_update`、`dot_schedule` 与 `dot_archive` 工具 |

-----

<a id="related-documentation"></a>
## 相关文档

- [Schedule 子系统](../../docs/subsystems/schedule.zh.md)——dot 委托调度工作所用的持久任务契约。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-dots)——挂载 preset 所贡献的六个 dot schema。
- [添加包](../../docs/cookbook/adding-a-package.zh.md)——本包组遵循的包布局与 README 规则。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本包组按设计仅支持单宿主：盒内移植去掉了 fleet、peer RPC 与 browser API 面，派发消息携带 Session controller 的普通 `user-rpc` 来源，dot id 位于提示文本之中。为 dot 输入引入未来的核心消息来源会改变该契约，需要单独的决策。

</details>
