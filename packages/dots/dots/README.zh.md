---
description: "拥有独立工作区、主会话、持久记忆与调度的持久命名代理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-dots

[English](README.md) | 中文

## 概述

`dsh-dots` 管理 dot：用于跨越多次任务持续工作的持久命名代理。一个 dot 拥有工作区目录、跨重启存活的主会话、受管的 `AGENTS.md` 契约、有上限的 `MEMORY.md`、执行期工具白名单以及持久调度。本包注册 `dotsController` Remote 服务（`dots` 命名空间）并安装 `tools/pre-execute` 守卫；面向模型的工具位于 [`@deepseek-ai/dsh-tool-dots`](../tool-dots/README.zh.md)。记录存放在 `dots` 存储域中，单表以 dot id 为键，退役的 `registry.json` 文件在激活时一次性导入。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

在代理需要长期承担责任的地方挂载本包：持续对齐发布说明、盯住一个仓库、维护一份 FAQ。dot 会在多轮交互、重启与调度唤醒之间保留其目的与累积记忆，因此下一次派发会带着同样的上下文开始，而不是一段全新对话。仅当没有任何内容需要跨轮存活时才用于单轮工作；普通会话更省资源。

组合必须提供 `tools`、`sessionController` 与 `storageDomain`。工作区注册表、权限 preset、Schedule 服务与 agent 注册表都是可选的：需要其中之一的操作会以 `dots/unavailable` 显式失败或给出警告，其余生命周期照常工作。

### 配置

除 schema 施加的默认值外，所有字段都是可选的。profile 可从 `cordis.yml` 修改这些字段：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `$DSH_HOME/dots` | dot 根目录，为每个 dot 保存一个目录，并存放旧版 `registry.json`。 |
| `defaultPreset` | `standard` | 请求未指定时，新 dot 使用的 agent preset。 |
| `defaultPermissionPreset` | 未设置 | 请求未指定时，应用到新 dot 的权限 preset。 |
| `maxDots` | `32` | 活跃 dot 上限。 |
| `maxTaskBytes` | `20000` | 一次派发或一条记忆备注的最大 UTF-8 字节数。 |
| `maxPurposeBytes` | `4000` | dot 目的的最大 UTF-8 字节数。 |
| `maxMemoryBytes` | `8192` | 一次派发注入的 `MEMORY.md` 字节数，取自文件尾部。 |
| `enforceToolAllowlist` | `true` | 在执行期强制 `allowedTools`。 |
| `allowedPresets` | 未设置 | dot 可请求的 agent preset。省略或空列表表示允许所有已配置 preset。 |
| `allowedPermissionPresets` | 未设置 | dot 可请求的权限 preset。省略或空列表表示允许所有已配置 preset。 |

两个白名单都在激活时校验，并在每次请求时再次校验。若配置的默认值被自身白名单排除，激活失败；请求的 preset 不在非空白名单中时，该请求失败并给出允许集合。Schemastery 把省略的列表读作空列表，因此空列表表示“不做限制”，而不是“什么都不允许”。

### Remote 操作

服务以 `ctx.dotsController` 挂载，并绑定 Typert Remote 命名空间 `dots`。操作集合刻意保持精简且稳定；Web GUI 使用它，其他 Remote 消费者同样可以使用。

| 方法 | 请求字段 | 结果 |
|---|---|---|
| `list` | `includeArchived?` | 按存储顺序返回每个 dot 及其实时状态。 |
| `create` | `name`、`purpose`、`preset?`、`permissionPreset?`、`allowedTools?`、`model?` | 新建的 dot 及非致命警告。 |
| `assign` | `dot`、`task`、`from?` | 受理结果，而非完成结果。 |
| `update` | `dot`、`purpose?`、`addMemory?`、`allowedTools?` | 更新后的 dot。 |
| `archive` | `dot`、`stopSchedules?` | 归档摘要，含已删除调度数量与警告。 |
| `scheduleList` | `dot` | 该 dot 的活跃调度。 |
| `scheduleCreate` | `dot`、`title`、`prompt`，以及 `after_seconds`、`at`、`every_seconds`、`daily`、`weekly`、`cron` 中恰好一个 | 新建的调度摘要。 |

dot 引用可以是精确 id，也可以是不区分大小写的名称。每个变更方法都接受可选的末尾 `signal` 以支持调用方取消。

### 创建

创建会校验名称、目的、白名单，并对照实时目录校验模型，然后创建 `$DSH_HOME/dots/<dot-id>/`，其中包含 `AGENTS.md`、`MEMORY.md` 与 `.dsh-dot/manifest.json`。当注册表已挂载时，会为该目录注册工作区，使用请求的 preset 创建主会话，以 dot 名称命名会话，应用权限 preset，并选择请求的模型。请求的权限 preset 应用失败时，创建会安全失败：已创建的主会话以归档 dot 持久隔离，不记录未应用的权限 preset，拒绝其全部工具，并在错误中报告目录与会话。工作区注册或重命名失败会变成警告；会话创建失败时，若既未产生工作区也未产生会话，目录会被删除，否则会报告保留下来的路径。

### 派发投递

一次派发会通过 Session controller 恢复主会话，并以 `queue` 模式排入一条 `[DOT ASSIGNMENT]` 提示，因此运行中的 dot 会在后续轮次收到它，且每个 dot 串行处理派发。消息框架携带 dot 名称、dot id、目的、派发 id、调用方、`MEMORY.md` 的有界尾部以及任务文本。控制器仅在提示被受理后才记录 `lastAssignedAt` 并递增 `assignmentCount`。

该派发以 Session controller 的普通 `user-rpc` 消息来源记录，因为这是盒内提示 API 唯一写入的来源。因此 dot id 随提示文本一起传递，而不是通过 `source.kind === 'dot'` 的消息来源；本次移植刻意不改动任何核心会话事件类型。

### 持久化与旧版注册表

记录存放在 `dots` 存储域（版本 1，表 `dots`，以 dot id 为键）。每条已存储记录都用与旧文件注册表相同的检查解码，格式错误的记录会拒绝打开存储域，而不会进入生命周期。

激活时，若 `$DSH_HOME/dots/registry.json` 存在且表为空，则先校验全部记录，再在任何行写入前将文件重命名为 `registry.json.importing`。该日志保留中断恢复所需的原始内容：激活时逐一核对已有行，补齐缺失行，最后才重命名为 `registry.json.imported`。已有行冲突、源文件与日志同时存在，或已有不同的导入备份时，激活会失败并保留证据。若文件在表非空时仍然存在，会在日志中报告并原样保留——既不合并，也不删除。

### 调度

`scheduleCreate` 把 dot 带框架的 `[DOT SCHEDULED TASK]` 提示存入盒内 Schedule 服务，并绑定到 dot 的主会话。任务到期时 Schedule 服务会恢复冷会话，因此调度可跨宿主重启存活。本包自身不保存调度状态；未挂载 Schedule 服务的组合会报告 `dots/unavailable`。

### 权限与护栏

dot 主会话可以携带任意已配置的权限 preset。`allowedTools` 由 `tools/pre-execute` 监听器强制执行：接受精确工具名与结尾 `*` 前缀，空数组拒绝所有工具。工具 schema 保持可见，仅执行被拒绝。dot 永远不能调用 `dot_*` 工具，dot 的活跃子代理会话会通过祖先链同时继承这两条规则。归档会停止该 dot 的调度、取消其运行中的轮次，并将其从活跃列表移除。归档主会话及其活跃后代仍受守卫约束：即使调度删除或取消失败，或刻意保留调度，也拒绝全部工具。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部说明——点击展开</summary>

### 设计原则

三项承诺塑造了本包。第一，持久记录集合是唯一事实来源：dot 目录、会话与调度都通过端口访问，绝不做缓存。第二，生命周期是一个普通类，因此其规则无需 Cordis 上下文即可测试；Cordis 适配器与 Remote 服务都是其上的薄层。第三，每个随部署变化的选项都是经过校验的 `Config` 字段，而协议形态的行为——派发框架、守卫规则、记录校验——是固定代码。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`name`、`inject`、`Config`、`apply` |
| [`src/types.ts`](src/types.ts) | 值类型、宿主端口类型与 Remote 线格式类型 |
| [`src/config.ts`](src/config.ts) | Schemastery schema 与 preset 白名单校验 |
| [`src/storage.ts`](src/storage.ts) | `dots` 存储域声明与记录 schema |
| [`src/record.ts`](src/record.ts) | 持久记录与旧版文档校验 |
| [`src/legacy.ts`](src/legacy.ts) | `registry.json` 的一次性导入 |
| [`src/store.ts`](src/store.ts) | 建立于存储域表之上的记录集合 |
| [`src/controller.ts`](src/controller.ts) | 创建、列出、派发、更新、调度、归档与守卫规则 |
| [`src/host.ts`](src/host.ts) | 面向会话、工作区、权限与 Schedule 服务的 Cordis 适配器 |
| [`src/guard.ts`](src/guard.ts) | `tools/pre-execute` 监听器 |
| [`src/service.ts`](src/service.ts) | `dotsController` Typert Remote 服务 |
| [`src/paths.ts`](src/paths.ts) | 名称、路径、契约与记忆辅助函数 |

### 存储域

存储域以 `defineDomain({ name: 'dots', version: 1, tables: { dots: domainTable<DotId, DotRecord>(schema) } })` 声明。schema 是一个调用 [`decodeDotRecord`](src/record.ts) 的 `z.unknown()` 转换，因此打开存储域与旧版导入共用同一个校验器。变更在 [`DotStore`](src/store.ts) 内部串行化，因此无需文件锁即可让活跃 dot 上限与重名检查免于竞态。

### 宿主端口

生命周期只通过 `DotsHost` 接口接触宿主：创建 Workspace、创建与重命名会话、列出会话、读取或取消活跃 agent、应用权限 preset、读取模型目录、选择模型、排入提示，以及创建、列出或删除调度。[`src/host.ts`](src/host.ts) 在 `ctx.sessionController`、`ctx.workspaceRegistry`、`ctx.permissionPresets`、`ctx.agents` 与 `ctx.schedule` 之上实现该接口；测试套件使用结构化假实现。状态来自一次 `sessionController.list` 读取：轮内为 `running`，agent 存活为 `idle`，仅有会话行时为 `asleep`，会话行不存在时为 `missing`。

### 导出形态

本插件是函数插件：导出 `name`、`inject`、`Config` 与 `apply`，没有默认导出。服务类以具名导出提供，便于消费者为 `ctx.dotsController` 标注类型。多余的 `export default` 会让 Loader 折叠模块并丢弃 `inject`（[postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

</details>

<a id="further-exploration"></a>
## 进一步阅读

- [tool-dots](../tool-dots/README.zh.md) —— 调用本服务的六个面向模型的工具。
- [Schedule](../../schedule/schedule/README.zh.md) —— 本包委托的持久任务存储与投递。
- [Session controller](../../api/session-controller/README.zh.md) —— 会话创建、提示、列表与模型选择。
- [Storage domain](../../storage/storage-domain/README.zh.md) —— 持久 KV 存储域层。
- [模型体验契约](../../../docs/cookbook/adding-a-package.zh.md#4-write-the-package-readme) —— README 的门禁规则。

<a id="model-experience"></a>
## 模型体验

### dot 派发提示

#### 模型看到的内容

每次被受理的派发都会作为一条用户角色提示到达 dot 的主会话：即下面的固定框架，并插入 dot 名称、dot id、目的、派发 id、调用方、有界的 `MEMORY.md` 尾部以及任务文本。

##### 派发框架

```markdown
[DOT ASSIGNMENT]
Dot: <dot name>
Dot id: <dot id>
Purpose: <managed purpose>
Assignment: <assignment id>
From: <caller session id or "the user">

## Durable memory
<bounded MEMORY.md tail, or "none">

## Task
<task text>

Work in your workspace. When done, reply with a concise report: what you did, evidence, and anything unresolved.
```

#### Token 影响

dot 空闲请求中为零成本。一次派发在进入主会话收件箱时增加框架、目的以及至多 `maxMemoryBytes` 的记忆，且只增加一次；在压缩之前该文本会一直保留。

#### KV Cache 影响

框架是追加到 dot 历史中的新用户消息，因此保留可复用前缀，不会使既有缓存条目失效。修改 `maxMemoryBytes` 只影响修改之后排入的派发文本。

### 工具守卫拒绝

#### 模型看到的内容

归档 dot 返回 `Archived dots cannot execute tools.`。被拒绝的调用返回 `Error: <reason>`，且永远不会到达工具。dot 管理类调用返回 `A dot cannot create or manage other dots.`；白名单拒绝返回 `Tool "<name>" is not allowed for dot "<dot name>". Allowed: <patterns or "(none)">.`

#### Token 影响

拒绝文本是唯一成本，每次被拒调用出现一次；工具 schema 保持可见，因此固定 schema 成本不变。

#### KV Cache 影响

仅追加：拒绝文本是追加到会话中的工具结果，因此请求前缀保持可复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **仅单宿主** —— dot 的工作区、会话、调度与凭据都位于运行本插件的那台主机；被移除的 fleet、peer 与 browser API 面在此没有替代实现。
- **每个 dot 一个主会话** —— 派发按设计串行。dot 内的并行工作需要子代理或多个 dot。
- **派发来源不是 `dot`** —— 被受理的消息携带 Session controller 的普通 `user-rpc` 来源，因此需要按来源区分 dot 输入的消费者必须读取提示文本。改变这一点需要核心会话事件/来源改动，本次移植刻意避免。
- **归档不是事务性的** —— 无法删除的调度或无法取消的轮次会进入 `warnings`，而记录仍然会被归档。
- **子代理谱系跟随活跃会话** —— 子代理会话在祖先链活跃期间继承所属 dot 的策略；祖先变冷时链条终止。
- **模型不回写** —— 之后在 dot 会话输入框中更换的模型不会写回记录；记录保留创建时的选择。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本备注是工作上下文，不是契约。派发提示文本、守卫消息与记录校验都由单元断言固定；修改它们会改变模型可见行为，需要在同一次变更中更新录制会话快照。

待定问题：未来的核心消息来源是否应携带 dot 身份，而不是把身份嵌入提示文本；以及 Web GUI 是否需要 `dots` Remote 事件流，而不是轮询 `list`。

</details>
