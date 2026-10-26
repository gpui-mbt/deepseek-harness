# Agent Note: ChatGPT 提供方是内置包

Status: implemented

[English](2026-10-26-chatgpt-provider-in-box.md) | 中文

## 问题

[Sign in with ChatGPT](https://github.com/f4ah6o/dsh-SIWC) 曾作为外部 bundle 发布：独立工作区、自己的 `@f12o` 包、打过补丁的 `@deepseek-ai/dsh-typert-generator`、带有 SVG 内联 CSS 处理的自制客户端打包器，以及一行唯一的职责是把缺失注入服务变成启动失败的 preflight。用户必须先安装它才能拥有该提供方，而每一次 DSH 预发布都迫使该包重新固定 peer 版本。

把该能力内置带来四个外部布局曾以不同方式回答的问题：需要凭据但不需要浏览器时提供方挂载在哪里；登录如何在不重新实现授权接缝取消闩锁的情况下提交；客户端包如何在不自行挂载描述符的情况下访问 Remote 命名空间；以及适配器如何在不导入未文档化 SDK 模块的情况下重放 Responses 输出条目。

## 决定

### 提供方在 `dsh-base`，页面在 `dsh-web-app`

`@deepseek-ai/dsh-llm-chatgpt` 紧接 `llm` 之后挂载于 `packages/bundle/base/cordis.patch.yml`，`@deepseek-ai/dsh-client-ui-chatgpt` 作为浏览器行挂载于 `dsh-web-app`。路由以休眠状态挂载：它立即注册 `chatgpt`，但在账号连接前不公布任何模型，因此 `listModels` 返回 `[]` 而不是抛出，全新安装永远不会显示失败的提供方分组。浏览器包注册插件页卡片而不是 Settings 分区，因为提供方的账号与能力状态是某个命名空间的配置。

### 登录通过授权接缝提交

流程构造记录并调用 `AuthorizationSession.commit`，因此接缝的提交闩锁、其取消规则与凭据存储的跨进程锁都会生效；插件不再维护自己的提交标记。由于普通凭据读取回答的是进程快照，回调会在提交前通过一次加锁的空操作写入调和记录，这正是并发的本地退出登录或另一 Host 的变更能够拒绝写入的原因。提交开始后，取消会等待它，这是接缝已文档化的契约。

### Remote 命名空间集中挂载

`@deepseek-ai/dsh-api-remotes` 导入 `@deepseek-ai/dsh-llm-chatgpt/remote` 并与其他贡献一起挂载。因此浏览器包等待 `remote.chatgpt`，而不是运行一个调用 `$mount` 的子插件，客户端测试也可以经由测试运行时驱动命名空间，而不必启动真实描述符。

### 重放条目在本地序列化

Responses API 对其接受的条目类型返回的 JSON 词汇与输入相同，因此 `replayableOutputItem` 按判别字符串分支，接受 `message`、`function_call`、`reasoning`、`compaction` 以及仅存在于线上的 `configuration_update`，并用与校验已保存重放状态相同的谓词验证每一项。OpenAI SDK 内部的 `lib/responses/ResponseInputItems` 导入消失，SDK 版本可以独立移动，不可重放的类型仍然以清洗后的类型列表失败。

### 默认提供方钩子现在显式声明

`providerInfo` 将路由命名为 `ChatGPT`；图像投影、图像定价与重试策略有意保留基类默认值，因为该路由按归一化尺寸原样转发图像，且没有路由级价格或退避。`streamIdleTimeoutMs` 配置用于约束停滞的流，因为 SDK 超时只覆盖到响应头的时间。

## 考虑过的替代方案

- **作为实验性可选 bundle 发布。** 对未验证能力是正确的，但该提供方是按账号而非按安装启用的受维护产品面；可选 bundle 还会让基础组合意识不到 Models 页面列出的提供方。
- **保留外部插件的 `modifyRecord` 写入。** 它无需改动接缝即可保留加锁前的取消保证，但需要第二个提交闩锁，并让接缝对成功的登录报告 `NOT_COMMITTED`。
- **保留自行挂载的 Remote 贡献。** 内置测试按设计拒绝 `$mount`，客户端仍需要一个嵌套插件来排序描述符可用性。
- **用原生 fetch 重写 OpenAI Responses 传输。** SDK 已经携带适配器映射所需的流类型与错误数据；只有重放转换器是内部的。
- **随包发布 OpenAI 标志资源。** 该标志是第三方商标，内置 artwork 规则要求任何新图形获得设计者批准；该页面只使用文本。

## 后果

- 挂载内置行之前必须从配置中移除外部 bundle；两行注册 `chatgpt` 会显式失败。[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.2/chatgpt-provider-in-box/guide.zh.md)拥有迁移步骤，保留的凭据作用域与提供方 id 使已保存账号继续可用。
- 重放校验器留在 `responses.ts`，紧邻它所供给的终止输出校验，因此一个文件拥有对重放条目的全部检查。
- 测试套件移植外部插件的 OAuth、host 与适配器规格，并新增真实 Loader 组合；typert 生成器补丁与自制客户端构建被删除而不是移植。
- 客户端日语文案位于 `@deepseek-ai/dsh-client-locale-ja`，与所有其他命名空间一致。
