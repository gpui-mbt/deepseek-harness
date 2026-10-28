---
description: "The dots package group: persistent named agents with their own workspace, home Session, memory, and schedules."
kind: "package-group"
---

# dots/ — Persistent named agents

English | [中文](README.zh.md)

## Summary

A dot is a durable named agent for work that continues across assignments. Each dot owns a workspace directory, a home Session that survives restarts, a managed `AGENTS.md` contract, a bounded `MEMORY.md`, an execution-time tool allowlist, and durable schedules. Use this group when one agent should keep long-lived responsibility; a plain Session is the cheaper choice for single-turn work. The group contributes a Host service, a Typert Remote namespace, and six model-facing tools, with no multi-host routing.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`dots/`](dots/README.md) | Durable dot records, home Session lifecycle, assignment delivery, storage-domain persistence, and the `dotsController` Remote service |
| [`tool-dots/`](tool-dots/README.md) | Preset-scoped `dot_create`, `dot_list`, `dot_assign`, `dot_update`, `dot_schedule`, and `dot_archive` tools over `ctx.dotsController` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Schedule subsystem](../../docs/subsystems/schedule.md) — the durable task contract dots delegates scheduled work to.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-dots) — the six dot schemas a mounting preset contributes.
- [Adding a package](../../docs/cookbook/adding-a-package.md) — the package layout and README rules this group follows.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The group is single-host by design: fleet, peer RPC, and browser-API surfaces were dropped in the in-box port, and the assignment message carries the Session controller's ordinary `user-rpc` source with the dot id in the prompt text. A future core message source for dot input would change that contract and needs its own decision.

</details>
