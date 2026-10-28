---
description: "面向模型的 dot_create、dot_list、dot_assign、dot_update、dot_schedule 与 dot_archive 工具，建立在 dots controller 之上。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-dots

[English](README.md) | 中文

## 概述

`dsh-tool-dots` 为模型提供六个用于持久命名代理的工具：创建 dot、列出 dot 及其实时状态、排入一次派发、修改 dot 的目的或记忆、安排重复工作，以及归档 dot。每个工具都是 [`@deepseek-ai/dsh-dots`](../dots/README.zh.md) 所挂载 `dotsController` 服务的薄适配层，因此校验与生命周期规则集中在一处。本包不持有 dot 状态，也没有配置；挂载它会把工具加入当前作用域，由 preset 决定哪些代理获得这些工具。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

在同时挂载 [`@deepseek-ai/dsh-dots`](../dots/README.zh.md) 的组合中挂载本包；插件注入 `tools` 与 `dotsController`，因此在两者都存在之前保持惰性。它没有 `Config`。注册限定在挂载上下文内，因此 preset 可以把工具交给一个代理，而不给另一个。

| 工具 | 用途 |
|---|---|
| `dot_create` | 以名称、目的、agent preset、权限 preset、白名单以及可选的 provider/model/reasoning effort 创建一个 dot。 |
| `dot_list` | 列出 dot 及其实时状态（`running`、`idle`、`asleep`、`missing`），可选包含已归档的 dot。 |
| `dot_assign` | 向 dot 排入一个任务；调用在受理时返回，而非完成时。 |
| `dot_update` | 替换目的、追加带日期的记忆备注，或替换执行白名单。 |
| `dot_schedule` | 以恰好一个时间选择器创建持久调度。 |
| `dot_archive` | 停止活跃调度、取消运行中的轮次，并归档 dot。 |

dot 引用可以是精确 id，也可以是不区分大小写的名称。工具从不选择宿主：dot 属于运行本插件的那台主机。

### 调用返回什么

`dot_create` 返回新建的 dot 以及任何非致命警告，例如工作区注册失败但 dot 目录与主会话创建成功。`dot_list` 返回 dot 及其状态。`dot_assign` 返回 dot id、主会话 id 与 `status: "queued"`。`dot_update` 返回更新后的 dot。`dot_schedule` 返回调度 id、类型、标题与下次发生时间。`dot_archive` 返回已删除调度数量，以及无法删除调度或无法取消轮次时的警告。

### 参数校验

工具 schema 校验形态；本包额外拒绝 schema 无法表达的情况。`dot_create` 要求 `provider` 与 `model` 同时提供。`dot_schedule` 校验它收到的 JSON 选择器对象：`at` 接受 RFC 3339 字符串或 `{date, time, time_zone}`，`daily` 要求 `{time, time_zone}`，`weekly` 要求 `{time, time_zone, weekdays}` 且 ISO 星期为 1 到 7，`cron` 要求 `{expression, time_zone}`。格式错误的选择器会在任何状态变更之前失败。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部说明——点击展开</summary>

### 设计原则

工具是纯工厂：[`defineDotTools`](src/tools.ts) 接收它所调用的服务操作并返回完整定义，因此注册是唯一的副作用，每次调用都无需 Cordis 上下文即可测试。面向模型的文本从模型视角撰写：描述说明 dot 的用途以及一次调用做什么，绝不提及宿主、RPC 或存储。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`name`、`inject`、`apply` |
| [`src/tools.ts`](src/tools.ts) | 六个定义、选择器校验与 JSON 安全的结果投影 |

### 导出形态

本插件是函数插件：导出 `name`、`inject` 与 `apply`，没有默认导出，也没有 `Config`。`inject` 列表要求 `tools` 与 `dotsController`；缺少其一的组合会让该行保持未加载，而不是注册部分工具。

### 结果投影

Remote 结果携带只读数组与带品牌标识符。工具结果必须是无损 JSON，因此 [`src/tools.ts`](src/tools.ts) 在返回之前把每个 dot 投影为数组已复制的独立 JSON 对象，其他调用则返回仅含原始值的摘要。这样即使服务新增字段，面向模型的载荷也保持稳定。

</details>

<a id="further-exploration"></a>
## 进一步阅读

- [dots](../dots/README.zh.md) —— 这些工具背后的 `dotsController` 服务、存储域与工具守卫。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-dots) —— 模型实际收到的精确 schema。
- [tool-todo](../../todo/tool-todo/README.zh.md) —— 另一个按作用域注册的工具包及其模型体验格式。
- [添加工具](../../../docs/cookbook/adding-a-tool.zh.md) —— UI 呈现与结果元数据指引。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

模型看到从[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-dots)链接的六个生成 schema。每个描述都陈述了该调用最关键的生命周期规则：`dot_assign` 在受理时返回，`dot_schedule` 要求恰好一个选择器，`dot_archive` 会停止调度并取消运行中的轮次。

#### Token 影响

在工具可见的每个请求上都有固定 schema 成本；对给定包版本与注册作用域而言，schema 是静态的。

#### KV Cache 影响

在可见性与作用域不变时前缀稳定。新增或移除工具的 preset 变更会使 schema 块之后的复用失效。

### 工具结果

#### 模型看到的内容

每次成功调用返回格式化 JSON：`dot_create` 与 `dot_update` 返回新建或更新后的 dot，`dot_list` 返回 dot 列表，`dot_assign` 返回 `{"accepted": true, "dotId": ..., "sessionId": ..., "status": "queued"}`，`dot_schedule` 返回调度摘要，`dot_archive` 返回含 `deletedSchedules` 与可选 `warnings` 的归档摘要。失败返回 `Error: <message>` 且不改变任何状态。

#### Token 影响

结果 token 随列出的 dot 数量以及单个 dot 记录的大小增长；派发与归档结果很小且形态固定。

#### KV Cache 影响

仅追加：结果是追加在可复用请求前缀之后的工具消息，因此一次调用绝不会使既有缓存条目失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **没有读取单个 dot 的工具** —— `dot_list` 是唯一的查看调用；没有用于查看单个 dot 契约或记忆的 `dot_show`。当消费者需要时新增该工具，而不是扩展 `dot_list`。
- **工具从不选择宿主** —— 每次调用都指向运行本插件的主机；多宿主界面需要路由参数与已解析的 fleet，本次移植刻意省略。
- **选择器校验位于工具内** —— `dot_schedule` 校验 `at`、`daily`、`weekly` 与 `cron` JSON，因此服务必须对其他自行校验输入的 Remote 调用方仍然可用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本备注是工作上下文，不是契约。描述与结果渲染都是模型可见文本：修改它们需要在同一次变更中更新录制会话快照，而工具目录锚点只有在本包的生成器运行之后才会解析。

待定问题：一旦出现 fleet，`dot_list` 是否需要紧凑形式；fleet 不在本次移植范围内，因此尚无设计。

</details>
