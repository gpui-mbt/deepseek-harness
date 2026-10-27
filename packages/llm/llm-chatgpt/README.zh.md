---
description: "DeepSeek Harness 的 ChatGPT 订阅推理：通过 Sign in with ChatGPT 登录的账号目录、一个 Responses API 提供方路由，以及按模型的能力覆盖。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-chatgpt

[English](README.md) | 中文

## 概述

使用 ChatGPT 账号登录，并把该套餐作为模型提供方。Host 持有一个账号目录（授权保存在凭据存储中）、一个由 OpenAI Responses API 支撑的 `chatgpt` 提供方路由，以及提供方页面编辑的配置状态：当前账号与按模型的能力覆盖。该路由以休眠状态挂载：没有已连接账号时不公布任何模型，因此全新安装看不到可选模型。OAuth 通过 `authorization` 能力在系统浏览器中完成，回调只绑定一个回环端口；令牌不会进入 Client、会话日志或任何 Remote 结果。

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

在已经组合 `credentials`、`authorization` 与 `llm` 的位置挂载一行 `llm-chatgpt`。`dsh-base` 默认包含它。在 Web 界面打开 **插件 → ChatGPT**，选择 **继续使用 ChatGPT**，在浏览器中批准访问后，该路由开始列出此账号可用的模型。`dsh-base` 也在无头配置中包含该行：没有账号时，无头任务会报告 `CHATGPT_SIGN_IN_REQUIRED`，直到通过共享同一 `$DSH_HOME` 的 Web 配置连接账号。

提供方页面用于连接或重新授权账号、切换当前账号、刷新可列出的模型目录，以及保存按模型的能力覆盖。第二个账号只有在用户选择后才可用：存在多个已连接账号且没有已保存选择时，该路由拒绝自行猜测。在配置补丁中设置 `authorizeOnStart: true` 时，Host 激活期间如果没有已连接账号，会启动同样的浏览器登录，最多等待 `loginTimeoutMs` 的回调；未完成时该行失败，授权地址写入日志。

| 配置字段 | 默认值 | 含义 |
|---|---|---|
| `activeAccountId` | 未设置 | 已保存的当前账号；由提供方页面写入。 |
| `welcomeAcknowledged` | `false` | 是否已展示首次连接欢迎页。 |
| `authorizeOnStart` | `false` | 激活期间没有已连接账号时启动浏览器登录。 |
| `modelOverrides` | `[]` | 按 slug 覆盖上下文窗口、输入模态、推理档位与默认档位。 |
| `requestTimeoutMs` | `10000` | 单次 OAuth 或目录请求的期限。 |
| `loginTimeoutMs` | `300000` | 单次回环登录尝试的有效期。 |
| `loginPollIntervalMs` | `1000` | 回调挂起时 Client 的轮询间隔。 |
| `streamIdleTimeoutMs` | `120000` | 流式响应静默多久后失败；`0` 关闭该检查。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-chatgpt)是每个可用字段及其 JSDoc 的完整来源。

<a id="understand-the-implementation"></a>
## 实现说明

**账号与授权。** 每个账号是 `dsh-chatgpt` 作用域下的一条 `grant` 凭据记录：client id、已校验的 subject、离线授权，以及一个 `grantGeneration` 计数器，用于在本地退出登录后使进行中的工作失效。另有一条 `dsh-chatgpt/host` 记录保存安装的 `urn:uuid:` host id，授权请求以 `ext_agent_host_id` 呈现它。旧记录若未带该前缀，会在激活时就地修复。

**授权流程。** `ChatGptHost` 为每个已保存账号注册一条 `authorization` 流程，并为每次尝试在 `127.0.0.1` 上启动一个回环服务器。回调校验 `state`，用捕获的 PKCE verifier 交换代码，通过授权源发布的 JWKS 校验签名的 ID token（issuer、audience、nonce、有效期、subject，以及存在时的 `azp`），再通过 `AuthorizationSession.commit` 提交记录。不完整的授权——缺少套餐作用域或没有刷新令牌——只保存已校验的注册信息而不保存令牌，并报告失败尝试，以便下次登录重新授权同一账号。新的登录会在最终凭据提交锁内校验将被替换的记录与预期的授权代数，因此并发的退出登录或另一 Host 的账号变更会拒绝这次写入。

**请求。** 适配器每轮向 Responses API 发送完整会话，使用 `store: false`、`stream: true` 与 `include: ['reasoning.encrypted_content']`。工具以 `additional_tools` developer 条目发送，而不是顶层 `tools` 字段；当提供方、模型与账号仍然匹配时，每条助手消息重放其 `replayState` 中保存的输出条目。重放身份使用请求的模型路由；提供方返回的快照模型另存为 `responseModel`，因此别名解析不会丢弃不透明推理。Host 关闭时中止现有请求，并拒绝异步账号发现之后的新请求准入。流事件映射为 harness 的块词汇；终止的 `response.completed` 是必需的，且流式与终止输出条目必须一致。只有提供方计数器完整且内部一致时，用量才成为 token 用量块。

**失败。** 提供方 HTTP 失败映射到共享 LLM 代码（`AUTH`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`），保留套餐的精确代码 `subscription_sharing_usage_limit_exceeded`，并保留 `retry-after`。刷新遇到 `invalid_grant` 时把记录降级为 `needs-sign-in` 并报告 `CHATGPT_SIGN_IN_REQUIRED`；退出登录会在写入无令牌记录前中止该账号进行中的工作。

<a id="further-exploration"></a>
## 延伸阅读

- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md) — 本路由实现的适配器与流块契约。
- [ChatGPT 账号子系统](../../../docs/subsystems/chatgpt-accounts.zh.md) — 账号记录、登录流程与模型能力规则。
- [凭据子系统](../../../docs/subsystems/credentials.zh.md) — 记录存储与引用解析。
- [授权能力](../../../packages/credentials/authorization/README.zh.md) — 流程、通知与提交语义。
- [`@deepseek-ai/dsh-client-ui-chatgpt`](../../client/ui-chatgpt/README.zh.md) — 提供方页面与输入区提示。

<a id="model-experience"></a>
## 模型体验

无，因为适配器只翻译 agent 循环已经组装的请求，不添加自己的提示、工具或结果文本。

#### KV Cache 影响

该路由每轮重发完整会话，并保留提供方的提示前缀复用；模型、账号或重放状态不匹配时会丢弃受影响消息的重放推理条目，从而使该点之后的前缀复用失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **单一请求图像投影。** 图像以归一化尺寸的 base64 data URL 传输；该路由不声明路由级图像预算，因此循环的图像卸载策略是唯一约束。
- **没有提供方输出上限。** Responses 调用从不发送 `max_output_tokens`，因此调用方的 `maxTokens` 会被拒绝而不是被尊重，token 计量也没有可报告的默认输出上限。
- **套餐能力表在源码中。** 七个已知模型 slug 及其公开限制位于 `src/models.ts`，并附有来源文档 URL；新模型只有在其事实被加入或配置覆盖提供上下文窗口后才可选。
- **账号选择是显式的。** 已保存的 `activeAccountId` 不匹配任何已连接账号时，该路由保持未登录状态，而不会回退到唯一账号。
- **配置编辑需要可编辑的配置。** 切换账号、保存覆盖与确认欢迎页通过 `configEditor` 写入；没有它的组合仍可读取，但这些变更会被拒绝。
- **目录缓存是进程内的。** Host 重启后会从提供方重新读取账号目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
