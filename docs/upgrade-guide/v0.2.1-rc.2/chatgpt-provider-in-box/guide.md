---
kind: upgrade-guide
description: "The ChatGPT provider is in-box; remove the external @f12o/dsh-siwc bundle and its preflight row."
---

# The ChatGPT provider ships in-box

English | [中文](guide.zh.md)

## Change

A ChatGPT-plan provider is now part of the installation as `@deepseek-ai/dsh-llm-chatgpt` (`dsh-base`) plus `@deepseek-ai/dsh-client-ui-chatgpt` (`dsh-web-app`). A profile that also keeps the external `@f12o/dsh-siwc` bundle mounts two rows registering the provider route `chatgpt`; the second registration fails, and the page and preflight rows are duplicated. Both packages keep the published contracts of the external plugin: provider id `chatgpt`, Remote namespace `chatgpt`, and the `dsh-chatgpt` credential scope, so saved accounts keep working after the external bundle is removed. The in-box page registers as a Plugins-page card instead of a Settings section, and the OpenAI logo asset is not included.

## Migration

1. Remove the external bundle from the profile: edit `$DSH_HOME/profiles/<name>/package.json` and delete `@f12o/dsh-siwc` from `dsh.profile.bundles` and from `dependencies`.
2. Delete the `chatgpt` and `chatgpt-preflight` rows from that profile's `cordis.patch.yml`. Row `id: chatgpt` and any `activeAccountId`, `modelOverrides`, `welcomeAcknowledged`, or `authorizeOnStart` fields are read by the in-box row when they are moved to `id: llm-chatgpt`.
3. Keep the credential file unchanged: records under scope `dsh-chatgpt` (including `dsh-chatgpt/host`) are read as before.
4. Restart the host and confirm `dsh` logs no duplicate-provider error. Open **Plugins → ChatGPT** and check that the saved account appears as connected and that its models are listed.
5. If the profile set `authorizeOnStart`, keep it under `id: llm-chatgpt`; the activation-time wait and log line are unchanged.
