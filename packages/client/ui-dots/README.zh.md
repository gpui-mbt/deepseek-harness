---
description: "dsh Web 客户端中的 Dots 页面：常驻命名智能体，以及它们的会话状态、工作分配、记忆、允许的工具和计划。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-dots

[English](README.md) | 中文

## 概述

在侧边栏打开 **Dots**，即可查看此部署中全部常驻命名智能体、它们的实时会话状态以及已经分配的工作。选中一个 dot 后，可以加入工作分配、追加长期记忆、编辑执行允许列表、查看或新增计划，并在当前窗口中打开它的主会话。新建 dot 使用部署默认值，因此页面没有宿主选择器，也没有模型目录。所有控件都调用 Host 的 `dots` Remote 命名空间并渲染返回的记录；页面不在本地暂存任何内容。

## 目录

- [使用此包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在会话面板和自动化面板旁打开 Dots 条目；页面会列出每个 dot 的状态标签、目的和分配次数。

**新建 dot** 需要名称与目的，并可选填写智能体预设、权限预设和执行允许列表。Host 会套用部署的模型默认值，创建 dot 目录，并注册其工作区与主会话，因此表单本身没有模型选项。**刷新** 会在页面之外发生变更后重新读取列表。

详情面板提供 **打开会话**，通过工作区导航显示该 dot 的主会话；**分配工作**，把一个任务加入队列并报告已受理而非已完成；**记住**，追加一条长期记忆；**允许的工具**，用逗号分隔的列表替换执行允许列表。保存时至少需要一个名称或以 `*` 结尾的前缀，因为空列表会禁止所有工具。

**计划** 列出该 dot 生效中的计划，并创建一条在指定整数秒后执行的一次性计划。**归档** 会先请求确认，然后停止该 dot 的计划，文件和历史仍然保留。

<a id="understand-the-implementation"></a>
## 实现说明

浏览器侧注册两个槽位。`main` 条目使用 `dots` 键，为部署中的每个 dot 渲染页面；`sidebar.panellist` 条目使用同一个 id、顺序为 20，并提供点阵图标与 **Dots** 标签。两者都是插件 fiber 的 effect，因此卸载会同时移除页面和条目。

`DotsPanel` 接收在 `apply` 中构建的唯一注入面：`dots` Remote 命名空间，以及委托给 `ctx.uiWorkspace.openSession` 的 `openSession` 回调。该导航调用会保留并加载会话，因此主会话处于休眠状态的 dot 与列表中已有会话的打开方式相同。

页面把所有状态保存在本地 React 状态中。挂载 effect 读取一次列表，选中 effect 读取该 dot 的计划，变更操作直接应用 Host 返回的记录；只有已受理的分配会重新读取列表，因为其结果不携带更新后的视图。失败的 Remote 结果会变成该操作自己的本地化句子，意外的拒绝也使用同一句子报告，因此 Remote 消息不会出现在页面上。

文案位于带类型的 `dots` 语言命名空间，包含英语与简体中文字典。该包使用 `@deepseek-ai/dsh-client-ui-primitives` 提供按钮、状态标签和归档对话框，其余部分通过只读取 `--dsw-alias-*` 令牌的 CSS Module 设置样式。

<a id="further-exploration"></a>
## 延伸阅读

- [`@deepseek-ai/dsh-dots`](../../dots/dots/README.zh.md) — 持久化的 dot 记录、主会话、执行守卫以及 `dots` Remote 命名空间。
- [`@deepseek-ai/dsh-tool-dots`](../../dots/tool-dots/README.zh.md) — 创建、分配和计划 dot 的模型可见工具。
- [`@deepseek-ai/dsh-client-ui-workspace`](../ui-workspace/README.zh.md) — `ctx.uiWorkspace` 背后的会话导航与目录浏览。
- [Slots 参考](../../../docs/subsystems/slots.zh.md) — 此包注册的 `main` 与 `sidebar.panellist` 约定。

<a id="model-experience"></a>
## 模型体验

None, as the dots page renders and mutates Host-held records without contributing model context or Session events.

#### KV Cache effect

None; the package sends no model request and changes no cached prefix.

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **页面等待 Host 命名空间。** 未挂载 `@deepseek-ai/dsh-dots` 时，两个条目都会停在 `remote.dots` 上，不会出现页面、标签或图标。
- **没有宿主选择器，也没有模型选择器。** 单宿主设计使新建始终使用部署默认值；按 dot 选择模型路由只能通过接受该参数的模型可见工具完成。
- **计划创建仅支持一次性。** 页面提交 `after_seconds`；每日、每周、cron 与固定钟点目标仍通过模型可见的计划工具提供。
- **允许列表无法清空为不受限。** Remote 的 `update` 方法把省略的列表视为不修改，把空列表视为禁止所有工具，因此页面要求至少一个模式。
- **列表只在挂载时读取，不做订阅。** 没有转发事件或轮询会更新它；请使用 **刷新** 重新读取状态与分配次数。
- **名称校验属于 Host。** 重名或非法名称会以通用的创建失败显示，而不是字段级提示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者使用的工作上下文——点击展开</summary>

None.

</details>
