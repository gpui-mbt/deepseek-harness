---
description: "Sign in with ChatGPT 账号目录：凭据记录、回环授权流程、Responses API 适配器，以及按模型的能力覆盖。"
kind: "subsystem"
---

# ChatGPT 账号

[English](chatgpt-accounts.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-chatgpt` 让一份 ChatGPT 订阅可作为模型提供方使用。它拥有三样东西：令牌以凭据存储中的 `grant` 记录保存的账号目录、填充这些记录的 Sign-in-with-ChatGPT 授权流程，以及使用当前账号访问令牌与 OpenAI Responses API 通信的 `chatgpt` 提供方路由。模型目录就是该账号提供方列表公布的内容，过滤为可见条目，并且只有在已知上下文窗口时才被接纳；配置覆盖可以提供或替换每一项能力。在账号连接之前路由保持休眠，因此提供方绝不会公布无法认证的模型。

## 目录

- [账号记录](#account-records)
- [Host 标识](#host-identity)
- [授权](#authorization)
- [模型目录与能力](#model-catalog-and-capabilities)
- [请求与重放](#requests-and-replay)
- [失败](#failures)
- [配置](#configuration)
- [Cordis API](#cordis-api)

-----

<a id="account-records"></a>
## 账号记录

每个账号是 `dsh-chatgpt` 作用域下的一条凭据记录，键为 `account-<uuid>`。其载荷只由本插件写入，并在读取时校验：

| 字段 | 含义 |
|---|---|
| `accountId` | 记录键中的账号 id，在载荷中重复出现以便校验。 |
| `clientId` | OpenAI 为该账号签发的客户端注册；新注册从占位值 `dynamic_agent_client` 开始并保存签发的 id。 |
| `subject` | 已校验的 OIDC subject；重新授权必须匹配。 |
| `email` | 仅当 ID token 携带已校验的邮箱时存在。 |
| `grantGeneration` | 本地退出登录时递增；进行中的目录加载与已准备调用会比较它，拒绝混用不同代数。 |
| `status` | `connected`（存在令牌）或 `needs-sign-in`（保留注册、无令牌）。 |
| `accessToken`、`refreshToken`、`idToken`、`expiresAt`、`scopes` | 离线授权，仅在已连接时存在。 |
| `createdAt` | 用于列表顺序的稳定创建时间。 |

Client 看到的是 `ChatGptAccountView`：标签、已校验邮箱、状态、当前标记与该账号已接纳的模型。令牌不会出现在任何 Remote 结果、日志行或会话事件中。

<a id="host-identity"></a>
## Host 标识

一条 `dsh-chatgpt/host` 记录保存 `{ version: 1, hostId: 'urn:uuid:<v4>' }`。授权请求以 `ext_agent_host_id` 呈现它，提供方据此在不同登录之间识别该安装。激活会就地修复旧的无前缀 UUID 值，并拒绝任何不是 v4 UUID 的值。

<a id="authorization"></a>
## 授权

`ChatGptHost` 为每个已保存账号注册一条 `authorization` 流程，并为每次尝试在 `127.0.0.1` 的临时端口上启动一个回环 HTTP 服务器。一次尝试分四步：

1. 用 PKCE `S256`、新的 `state`、新的 `nonce`、所需作用域（`openid`、`profile`、`email`、`offline_access`、`resource.invoke`、`chatgpt.tokens.use.direct`）与 API resource 构造授权地址。地址通过流程通知发布，绝不作为携带令牌的句柄返回。
2. 提供 `GET /auth/callback`。只有仍在等待浏览器的尝试接受回调；`state` 以常量时间比较；重新授权还要求回调的 client id 与已校验 subject 匹配已保存的注册。
3. 交换代码，并对照授权源公布的 discovery 文档与 JWKS 校验返回的 ID token：issuer 相等、HTTPS 且同源端点、audience、nonce、有效期、非空 subject，以及存在时的 `azp`。
4. 通过 `AuthorizationSession.commit` 提交记录。不完整的授权——缺少套餐作用域或没有刷新令牌——改为提交无令牌的 `needs-sign-in` 注册，并以指出缺失权限的消息使尝试失败。

提交是能力接缝的写入路径，因此尝试的提交闩锁与凭据存储的跨进程锁都会生效。提交前，回调用一次加锁的空操作写入读取记录，因为普通读取回答的是进程快照，可能看不到另一进程的退出登录。该读取也校验预期的授权代数；并发的本地退出登录或另一 Host 的变更会拒绝这次写入。提交前的取消是有效的：流程信号会中止挂起的交换，且不会保存记录。

每次尝试受 `loginTimeoutMs` 约束，结束后其脱敏视图保留十分钟，并在完成、取消或失败时关闭回环服务器。Host 在销毁期间中止并排空所有挂起尝试。

<a id="model-catalog-and-capabilities"></a>
## 模型目录与能力

目录是带账号 bearer 令牌的 `GET https://api.openai.com/v1/models`，过滤为 `visibility: "list"`，并按账号缓存在进程内存中。加载按账号合并、受 `requestTimeoutMs` 约束、被账号退出登录中止，并在更新的加载或失效推进账号代数时丢弃。`refreshModels` 先失效再重新加载。

能力来自两个来源，按此顺序：

1. 按精确 slug 键控的配置 `modelOverrides` 行可声明上下文窗口、输入模态、可接受的推理档位与默认档位。
2. 否则由包内冻结的已记录模型事实表提供。

两个来源都没有上下文窗口的模型不会被接纳：它不进入列表、不能被选择，提供方页面会标记为需要窗口。只有上下文覆盖的未知模型会以未声明输入模态的方式公布，harness 将其读作“无图像能力”而非“未知”。

`resolveModel` 会重新读取目录，因此不再可见的 slug 会以 `UNKNOWN_MODEL` 失败。`prepareCall` 一次性捕获账号选择、覆盖与超时，针对该快照解析元数据、刷新令牌，并在返回前重新校验授权代数。因此解析期间的配置变更无法把一个账号的目录与另一个账号的令牌组合起来。

<a id="requests-and-replay"></a>
## 请求与重放

适配器以以下内容流式调用 `POST https://api.openai.com/v1/responses`：

- 以 `input` 发送完整会话，`store: false`、`stream: true`、`include: ['reasoning.encrypted_content']`；
- 工具作为 `additional_tools` developer 条目发送：工具历史不完整时一次性全部前置，完整时在每个历史新增处发送；
- 当终止助手消息的 `replayState` 匹配提供方、模型与账号时，逐条重放其保存的输出条目；
- 不发送 `max_output_tokens`、`temperature` 或 `stop`。

流事件映射为 `block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`，以及一个携带重放状态的终止 `finish`。`response.completed` 是必需的；在此之前结束的流以 `STREAM_CLOSED` 失败。流式输出条目按 `output_index` 排序、必须从零连续，并与终止响应的输出类型一致。流静默 `streamIdleTimeoutMs` 后以 `STREAM_IDLE_TIMEOUT` 中止请求。

<a id="failures"></a>
## 失败

| 情况 | 结果 |
|---|---|
| 没有已连接账号，或授权被刷新失效 | `CHATGPT_SIGN_IN_REQUIRED` |
| 账号记录缺失 | `CHATGPT_ACCOUNT_MISSING` |
| 操作中途授权代数或已保存注册变化 | `CHATGPT_ACCOUNT_CHANGED` |
| HTTP 401/403 | `AUTH` |
| HTTP 429 | `RATE_LIMIT` |
| 上下文窗口拒绝文本 | `CONTEXT_WINDOW_EXCEEDED` |
| HTTP 400/413 | `INVALID_REQUEST` |
| HTTP ≥ 500 | `SERVER` |
| 套餐的精确代码 `subscription_sharing_usage_limit_exceeded` | 原样保留 |
| 非流式或畸形响应 | `OPENAI_RESPONSES_ERROR` / `MALFORMED_RESPONSE` |
| 不可重放的输出条目 | `UNSUPPORTED_CONTENT`，只列出经过清洗的类型名 |
| 停滞的流 | `STREAM_IDLE_TIMEOUT` |

`retry-after` 会转换为共享重试层使用的 `providerRetryAfterMs`；SDK 自身的重试被关闭，因此重试归属仍在 `llm-retry`。

<a id="configuration"></a>
## 配置

生成的[配置目录](../config-catalog.zh.md#deepseek-aidsh-llm-chatgpt)拥有每个字段。有两个选择值得在此说明：

- `authorizeOnStart` 是唯一的激活期网络路径。没有已连接账号时，它在 `apply` 期间启动浏览器流程、记录授权地址并等待回调；无法完成该流程的组合会使该行失败，而不是在没有凭据的情况下开始工作。
- 持久化的配置状态（`activeAccountId`、`welcomeAcknowledged`、`modelOverrides`）通过 `configEditor` 写入。没有它的组合仍可读取，但变更会被拒绝。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxchatgptcontroller--chatgptcontroller"></a>

### `ctx.chatgptController` — `ChatGptController`

Typed Remote operations for profile ChatGPT accounts, catalogs and sign-in.

```ts cordis-catalog
/**
 * Read account, catalog and sign-in state without exposing credentials.
 * @returns the redacted account and OAuth-attempt snapshot.
 */
@Remote getState(): Promise<ChatGptState>

/**
 * Start a Host-owned OAuth callback and return the URL for the system browser.
 * @param request - a saved account for reauthorization, or an empty request for a new registration.
 * @returns the safe attempt handle and authorization URL.
 */
@Remote beginLogin(request: ChatGptLoginRequest): Promise<ChatGptLoginTicket>

/**
 * Cancel an unfinished local sign-in attempt.
 * @param request - opaque attempt handle returned by {@link beginLogin}.
 */
@Remote cancelLogin(request: ChatGptCancelLoginRequest): Promise<void>

/**
 * Select the profile's ChatGPT account for future model requests.
 * @param request - the saved account to activate.
 */
@Remote setActiveAccount(request: ChatGptAccountRequest): Promise<void>

/**
 * Remove an account and revoke its refresh token when possible.
 * @param request - account to disconnect.
 * @returns whether OpenAI confirmed token revocation.
 */
@Remote signOut(request: ChatGptAccountRequest): Promise<ChatGptSignOutResult>

/**
 * Refresh one saved account's list-visible model catalog.
 * @param request - account whose catalog should be refreshed.
 * @returns the updated redacted state.
 */
@Remote refreshModels(request: ChatGptAccountRequest): Promise<ChatGptState>

/**
 * Store or clear one profile capability override.
 * @param update - exact account catalog slug and its replacement override.
 * @returns updated redacted state.
 */
@Remote setModelConfig(update: ChatGptModelConfigUpdate): Promise<ChatGptState>

/** Remember that a Client has shown the initial account welcome view. */
@Remote acknowledgeWelcome(): Promise<void>
```

Source: [`packages/llm/llm-chatgpt/src/index.ts`](../../packages/llm/llm-chatgpt/src/index.ts)
<!-- END GENERATED cordis-surface -->

## 已知限制与后续工作

- **提供方能力事实是源码数据。** 已记录模型表是一份快照；表不认识的 slug 需要至少提供上下文窗口的配置覆盖。
- **单一当前账号。** 路由用一个选定账号认证；没有按模型的路由。
- **没有用量上报。** 适配器报告请求 token 用量，而不是套餐配额；提供方页面链接到套餐自身的用量视图。
- **进程内目录。** 缓存不被持久化，因此重启会重新读取提供方列表。
