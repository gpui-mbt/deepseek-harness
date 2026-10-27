---
description: "dsh Web 客户端插件页中的 ChatGPT 提供方页面，以及它在输入区贡献的套餐提示。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-chatgpt

[English](README.md) | 中文

## 概述

在侧边栏打开 **插件**，在官方分组中选择 **ChatGPT**，即可连接 ChatGPT 账号、切换当前账号、刷新该账号可用的模型列表，并设置按模型的能力。页面不在本地暂存任何内容：每个控件都调用 Host 的 `chatgpt` Remote 命名空间并渲染返回的快照，因此同时打开的两个页面保持一致。输入区的一个条目用于标记当前路由到 ChatGPT 的会话，并显示最近一次失败回合的套餐用量上限提示。该页面仅在 Host 提供命名空间时存在。

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

**继续使用 ChatGPT** 会在点击时预开标签页并打开授权页；被拦截的弹窗会留下可见链接作为退路。回调挂起期间，页面按 `loginPollIntervalMs` 轮询 Host 快照、显示尝试阶段并提供取消；离开页面会取消它发起的尝试。账号列表标记 `已连接`、`需要注册` 或 `需要重新登录`；只有已连接账号能成为当前账号，页面不会自行在多个已连接账号之间选择。

提供方标签页保持 `window.opener` 隔离。跨源导航后，浏览器策略可能拒绝父页面关闭该标签页，因此弹窗清理仅尽力而为，不得阻止 Host 取消授权或页面卸载清理。只有 Host 确认取消后才提示：如果登录标签页仍然打开，请手动关闭；取消失败必须允许重试且不能报告成功。取消会关闭 Host 回调监听器，迟到的浏览器回调不能创建凭据。

**可用模型** 列出账号目录当前公布的模型。缺少上下文窗口的模型会标记为需要设置：展开它、填写窗口并保存。编辑器还会保存输入模态、模型接受的推理档位及其默认值；**使用官方模型默认值** 会移除覆盖。刷新会重新读取提供方目录并保留已保存的覆盖。

**退出登录** 会请求 Host 撤销刷新令牌，然后删除本地令牌；若撤销未获确认，页面会说明这一点，并保留注册信息以便再次登录。

<a id="understand-the-implementation"></a>
## 实现说明

插件注册到两个槽位。它的 `plugins.item` 条目为 `chatgpt` 命名空间渲染页面；`view: 'summary'` 返回一句话说明，`view: 'page'` 返回完整页面。它的 `conversation.composer.dock` 条目接收会话绑定，把会话事件窗口折叠为用量上限快照，并按绑定复用同一个可观察对象，使重新挂载读取同一事实。两者都是插件 fiber 的 effect，因此卸载会移除页面、提示与所有待处理尝试的跟踪。

文案位于带类型的 `chatgpt` 语言命名空间，日语语言包也会翻译它；页面从不逐字渲染 Host 错误消息，只显示自己的本地化失败文本。

<a id="further-exploration"></a>
## 延伸阅读

- [ChatGPT 账号子系统](../../../docs/subsystems/chatgpt-accounts.zh.md) — 账号记录、登录、目录与能力。
- [`@deepseek-ai/dsh-llm-chatgpt`](../../llm/llm-chatgpt/README.zh.md) — Host 提供方、Remote 命名空间与配置。
- [槽位参考](../../../docs/subsystems/slots.zh.md) — 此处使用的注册与 props 模型。

<a id="model-experience"></a>
## 模型体验

无，因为提供方页面与输入区提示只渲染账号状态，不贡献模型上下文或会话事件。

#### KV Cache 影响

无；该包不修改模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **页面需要 Host 命名空间。** 在没有 `@deepseek-ai/dsh-llm-chatgpt` 时挂载本包，条目会一直等待 `remote.chatgpt`；不会出现页面、摘要或提示。
- **用量上限是会话内的。** 输入区提示读取当前会话的事件窗口，因此其他会话的上限不会在此显示。
- **能力编辑按配置保存。** 覆盖存储在插件的配置文件中；共享同一安装的无头配置除非读取同一配置补丁，否则不会继承它们。
- **没有删除账号。** 退出登录有意保留注册信息；删除注册是凭据存储操作，不在本页面范围内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
