---
kind: upgrade-guide
description: "Persistent dots are in-box; replace the external @f12o/dsh-dots bundle, keep the tool names, and let the one-time registry import move records into the dots storage domain."
---

# Persistent dots ship in-box

English | [中文](guide.zh.md)

## Change

Persistent named agents are now part of the installation as `@deepseek-ai/dsh-dots` (Host service, storage domain, tool guard, and `dots` Remote namespace) plus `@deepseek-ai/dsh-tool-dots` (the six model-facing tools), both in `dsh-web-app`, and `@deepseek-ai/dsh-client-ui-dots` for the Web panel. A profile that also keeps the external `@f12o/dsh-dots` bundle mounts two rows that own the same records and tools: the second `dotsController` registration fails and the duplicate tools are rejected.

The in-box service keeps the published tool names (`dot_create`, `dot_list`, `dot_assign`, `dot_update`, `dot_schedule`, `dot_archive`) and the dot directory layout, so existing dots and presets keep working. Three contracts change:

- **One host only.** The peer/fleet plane (`hosts.json`, `host` arguments, remote selection) is gone.
- **Storage moved.** Records live in the `dots` storage domain, not in `$DSH_HOME/dots/registry.json`. The first activation imports a legacy registry once and renames it `registry.json.imported`.
- **Assignments are queued prompts.** Delivery uses the Session controller's ordinary `user-rpc` prompt, so the dot id rides in the `[DOT ASSIGNMENT]` frame instead of a dedicated message source.

## Migration

1. Remove the external bundle: edit `$DSH_HOME/profiles/<name>/package.json` and delete `@f12o/dsh-dots` from `dsh.profile.bundles` and from `dependencies`.
2. Delete the external `dots` row from that profile's `cordis.patch.yml`. The in-box row is `id: dots` in `dsh-web-app`; remove any `hostsFile`, `peer`, or `requestTimeoutMs` fields, which no longer exist. Keep `root`, `defaultPreset`, `defaultPermissionPreset`, the byte bounds, and `enforceToolAllowlist`; they keep their meaning.
3. Keep the dot directories. On the first activation, `<root>/registry.json` is validated and imported into storage, then renamed `<root>/registry.json.imported`. A registry that appears beside a non-empty table is logged and left untouched — reconcile it by hand before renaming it.
4. Restart the host and confirm the `dsh` log reports the imported record count once, then nothing on later starts.
5. Open the new **dots** sidebar panel and confirm the dots and their live status appear. Removing a dot's external schedules is not automatic: re-create any schedule the old bundle owned with `dot_schedule`, or confirm the Schedule service imported them.
6. Presets that listed the external tools keep the same names; no preset change is required. A dot still cannot call `dot_*` tools, and `allowedTools` is still enforced at execution time (now including live subagent sessions descended from a dot).
