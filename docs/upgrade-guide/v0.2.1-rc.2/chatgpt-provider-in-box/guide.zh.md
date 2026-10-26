---
kind: upgrade-guide
description: "ChatGPT 提供方已内置于安装包；请移除外部 @f12o/dsh-siwc 包及其 preflight 行。"
---

# ChatGPT 提供方随安装包内置

[English](guide.md) | 中文

## 变更

ChatGPT 套餐提供方现在是安装的一部分：`@deepseek-ai/dsh-llm-chatgpt`（`dsh-base`）与 `@deepseek-ai/dsh-client-ui-chatgpt`（`dsh-web-app`）。同时保留外部 `@f12o/dsh-siwc` 包的配置会挂载两个注册提供方路由 `chatgpt` 的行；第二次注册会失败，页面与 preflight 行也会重复。两个新包保留外部插件已发布的契约：提供方 id `chatgpt`、Remote 命名空间 `chatgpt` 与 `dsh-chatgpt` 凭据作用域，因此移除外部包后已保存账号仍然可用。内置页面注册为插件页卡片而非 Settings 分区，且不再包含 OpenAI 标志资源。

## 迁移

1. 从配置中移除外部包：编辑 `$DSH_HOME/profiles/<name>/package.json`，从 `dsh.profile.bundles` 与 `dependencies` 中删除 `@f12o/dsh-siwc`。
2. 从该配置的 `cordis.patch.yml` 删除 `chatgpt` 与 `chatgpt-preflight` 行。把 `id: chatgpt` 及其 `activeAccountId`、`modelOverrides`、`welcomeAcknowledged`、`authorizeOnStart` 字段移到 `id: llm-chatgpt` 后，内置行会读取它们。
3. 保持凭据文件不变：`dsh-chatgpt` 作用域下（含 `dsh-chatgpt/host`）的记录会被照常读取。
4. 重启 host，确认 `dsh` 日志没有重复提供方错误。打开 **插件 → ChatGPT**，确认已保存账号显示为已连接且其模型已列出。
5. 若配置设置了 `authorizeOnStart`，把它保留在 `id: llm-chatgpt` 下；激活期间的等待与日志行不变。
