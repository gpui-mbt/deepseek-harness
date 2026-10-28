---
description: "Persistent named agents with their own workspace, home session, durable memory, and schedules."
kind: "package-reference"
---

# @deepseek-ai/dsh-dots

English | [中文](README.zh.md)

## Summary

`dsh-dots` manages dots: durable named agents for work that continues across assignments. A dot owns a workspace directory, a home Session that survives restarts, a managed `AGENTS.md` contract, a bounded `MEMORY.md`, an execution-time tool allowlist, and durable schedules. The package registers a `dotsController` Remote service (`dots` namespace) and installs a `tools/pre-execute` guard; the model-facing tools live in [`@deepseek-ai/dsh-tool-dots`](../tool-dots/README.md). Records live in the `dots` storage domain, one table keyed by dot id, and the retired `registry.json` file is imported once at activation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this package where an agent should hold long-lived responsibility: keep a release note aligned, watch one repository, maintain one FAQ. A dot keeps its purpose and accumulated memory across turns, restarts, and scheduled wake-ups, so the next assignment starts with the same context instead of a fresh conversation. Use it for single-turn work only when nothing needs to survive the turn; a plain Session is cheaper.

The composition must provide `tools`, `sessionController`, and `storageDomain`. The Workspace registry, permission presets, the Schedule service, and the agent registry are optional: an operation that needs one of them fails loud with `dots/unavailable` or reports a warning, and the rest of the lifecycle keeps working.

### Configuration

Every field is optional except where the schema applies a default. A profile changes these from `cordis.yml`:

| Field | Default | Meaning |
|---|---|---|
| `root` | `$DSH_HOME/dots` | Dot root holding one directory per dot and the legacy `registry.json`. |
| `defaultPreset` | `standard` | Agent preset for a new dot when the request names none. |
| `defaultPermissionPreset` | unset | Permission preset applied to new dots when the request names none. |
| `maxDots` | `32` | Maximum active dots. |
| `maxTaskBytes` | `20000` | Maximum UTF-8 bytes in one assignment or memory note. |
| `maxPurposeBytes` | `4000` | Maximum UTF-8 bytes in a dot purpose. |
| `maxMemoryBytes` | `8192` | `MEMORY.md` bytes injected into one assignment, taken from the tail. |
| `enforceToolAllowlist` | `true` | Enforce `allowedTools` at execution time. |
| `allowedPresets` | unset | Agent presets a dot may request. An omitted or empty list admits every configured preset. |
| `allowedPermissionPresets` | unset | Permission presets a dot may request. An omitted or empty list admits every configured preset. |

Both allowlists are validated at activation and again on every request. A configured default that its own allowlist excludes fails activation, and a requested preset outside a non-empty allowlist fails that request with a message naming the allowed set. Schemastery reads an omitted list as empty, so an empty list means "no restriction" rather than "nothing allowed".

### Remote operations

The service mounts as `ctx.dotsController` and binds the Typert Remote namespace `dots`. The operation set is deliberately small and stable; the Web GUI uses it, and so may any other Remote consumer.

| Method | Request fields | Result |
|---|---|---|
| `list` | `includeArchived?` | Every dot with live status, in storage order. |
| `create` | `name`, `purpose`, `preset?`, `permissionPreset?`, `allowedTools?`, `model?` | The created dot and non-fatal warnings. |
| `assign` | `dot`, `task`, `from?` | Acceptance, not completion. |
| `update` | `dot`, `purpose?`, `addMemory?`, `allowedTools?` | The updated dot. |
| `archive` | `dot`, `stopSchedules?` | Archive summary with the number of deleted schedules and any warnings. |
| `scheduleList` | `dot` | The dot's active schedules. |
| `scheduleCreate` | `dot`, `title`, `prompt`, and exactly one of `after_seconds`, `at`, `every_seconds`, `daily`, `weekly`, `cron` | The created schedule summary. |

A dot reference is its exact id or its case-insensitive name. Every mutating method accepts an optional trailing `signal` for caller cancellation.

### Creation

Creation validates the name, purpose, allowlist, and model against the live catalog, then creates `$DSH_HOME/dots/<dot-id>/` with `AGENTS.md`, `MEMORY.md`, and `.dsh-dot/manifest.json`. It registers a Workspace for that directory when the registry is mounted, creates the home Session with the requested preset, titles the Session after the dot, applies the permission preset, and selects the requested model. If a requested permission preset fails, creation fails closed: the surviving home Session is durably quarantined as an archived dot, no unapplied permission preset is recorded, all its tools are denied, and the error identifies its directory and Session. A failed Workspace registration or rename becomes a warning; a failed Session creation removes a directory that produced no Workspace or Session and reports the surviving path otherwise.

### Assignment delivery

An assignment resumes the home Session through the Session controller and queues one `[DOT ASSIGNMENT]` prompt in `queue` mode, so a running dot receives it on a later turn and one dot processes assignments serially. The frame carries the dot name, dot id, purpose, assignment id, caller, the bounded tail of `MEMORY.md`, and the task. The controller records `lastAssignedAt` and increments `assignmentCount` only after the prompt is accepted.

The assignment is recorded with the Session controller's ordinary `user-rpc` message source, because that is the only source the in-box prompt API writes. The dot id therefore rides inside the prompt text instead of a `source.kind === 'dot'` message source; this port deliberately changes no core Session event type.

### Persistence and the legacy registry

Records live in the `dots` storage domain, version 1, table `dots`, keyed by the dot id. Every stored row is decoded with the same checks that the old file registry applied, and a malformed row rejects opening the domain instead of entering the lifecycle.

At activation, when `$DSH_HOME/dots/registry.json` exists and the table is empty, every record is validated, then the file is renamed to `registry.json.importing` before any row is written. This journal survives interruption: activation verifies every existing row against it, resumes missing rows, and only then renames it to `registry.json.imported`. Conflicting rows, simultaneous source and journal files, or a distinct existing imported backup block activation without deleting evidence. A file that survives beside a non-empty table is reported in the log and left untouched — never merged, never deleted.

### Scheduling

`scheduleCreate` stores the dot's framed `[DOT SCHEDULED TASK]` prompt in the in-box Schedule service, bound to the dot's home Session. The Schedule service restores a cold Session when the task is due, so a schedule survives host restarts. The package itself keeps no schedule state; a composition without the Schedule service reports `dots/unavailable`.

### Permissions and guardrails

A dot home Session can carry any configured permission preset. `allowedTools` is enforced by a `tools/pre-execute` listener: exact tool names and trailing `*` prefixes are accepted, and an empty array denies every tool. Tool schemas stay visible; only execution is denied. A dot can never call a `dot_*` tool, and a live subagent Session of a dot inherits both rules through its ancestor chain. Archiving stops the dot's schedules, cancels its running turn, and removes it from the active list. Archived home Sessions and their live descendants remain guarded: every tool is denied even when schedule removal or cancellation failed, or schedules were intentionally retained.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

Three commitments shape the package. First, the durable record set is the only source of truth: dot directories, Sessions, and schedules are reached through ports, never cached. Second, the lifecycle is a plain class so its rules stay testable without a Cordis context; the Cordis adapter and the Remote service are thin layers over it. Third, every deployment-varying choice is a validated `Config` field, while protocol-shaped behavior — the assignment frame, the guard rules, the record checks — is fixed code.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `name`, `inject`, `Config`, `apply` |
| [`src/types.ts`](src/types.ts) | Value, host-port, and Remote wire types |
| [`src/config.ts`](src/config.ts) | Schemastery schema and preset allowlist validation |
| [`src/storage.ts`](src/storage.ts) | `dots` domain declaration and record schema |
| [`src/record.ts`](src/record.ts) | Durable record and legacy-document validation |
| [`src/legacy.ts`](src/legacy.ts) | One-time import of `registry.json` |
| [`src/store.ts`](src/store.ts) | Record set over the domain table |
| [`src/controller.ts`](src/controller.ts) | Create, list, assign, update, schedule, archive, guard rules |
| [`src/host.ts`](src/host.ts) | Cordis adapter onto Session, Workspace, permission, and Schedule services |
| [`src/guard.ts`](src/guard.ts) | `tools/pre-execute` listener |
| [`src/service.ts`](src/service.ts) | `dotsController` Typert Remote service |
| [`src/paths.ts`](src/paths.ts) | Name, path, contract, and memory helpers |

### Storage domain

The domain is declared with `defineDomain({ name: 'dots', version: 1, tables: { dots: domainTable<DotId, DotRecord>(schema) } })`. The schema is a `z.unknown()` transform that calls [`decodeDotRecord`](src/record.ts), so domain opening and the legacy import share one validator. Mutations are serialized inside [`DotStore`](src/store.ts), which makes the active-dot cap and duplicate-name checks race-free without a file lock.

### Host ports

The lifecycle reaches the Host only through the `DotsHost` interface: create a Workspace, create and rename a Session, list Sessions, read or cancel a live agent, apply a permission preset, read the model catalog, select a model, queue a prompt, and create, list, or delete schedules. [`src/host.ts`](src/host.ts) implements that interface over `ctx.sessionController`, `ctx.workspaceRegistry`, `ctx.permissionPresets`, `ctx.agents`, and `ctx.schedule`; the suites use a structural fake. Status comes from one `sessionController.list` read: `running` inside a turn, `idle` with a live agent, `asleep` when only the Session row exists, and `missing` when it does not.

### Export shape

The plugin is a function plugin: it exports `name`, `inject`, `Config`, and `apply`, and has no default export. The service class is a named export so consumers can type `ctx.dotsController`. A stray `export default` would make the Loader collapse the module and drop `inject` ([postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

</details>

<a id="further-exploration"></a>
## Further Exploration

- [tool-dots](../tool-dots/README.md) — the six model-facing tools that call this service.
- [Schedule](../../schedule/schedule/README.md) — durable task storage and delivery this package delegates.
- [Session controller](../../api/session-controller/README.md) — Session creation, prompting, listing, and model selection.
- [Storage domain](../../storage/storage-domain/README.md) — the durable KV domain layer.
- [Model Experience contract](../../../docs/cookbook/adding-a-package.md#4-write-the-package-readme) — the README gating rules.

## Model Experience

### Dot assignment prompt

#### What the model sees

Every accepted assignment reaches the dot's home Session as one user-role prompt: the fixed frame below with the dot name, dot id, purpose, assignment id, caller, the bounded `MEMORY.md` tail, and the task text interpolated.

##### Assignment frame

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

#### Token effect

Zero cost in the dot's idle requests. An assignment adds the frame, the purpose, and up to `maxMemoryBytes` of memory once, when it enters the home Session's inbox; the text stays until compaction.

#### KV Cache effect

The frame is a new user message appended to the dot's history, so it preserves the reusable prefix and does not invalidate earlier cache entries. Changing `maxMemoryBytes` changes the retained assignment text only for assignments queued after the change.

### Tool guard denial

#### What the model sees

Archived dots return `Archived dots cannot execute tools.`. A denied call returns `Error: <reason>` and never reaches the tool. Dot management calls return `A dot cannot create or manage other dots.`; an allowlist refusal returns `Tool "<name>" is not allowed for dot "<dot name>". Allowed: <patterns or "(none)">.`

#### Token effect

Denial text is the only cost and appears once per refused call; tool schemas stay visible, so the fixed schema cost is unchanged.

#### KV Cache effect

Append-only: the denial is a tool result appended to the conversation, so the request prefix stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Single host only** — a dot's workspace, Session, schedules, and credentials live on the one host running this plugin; the removed fleet, peer, and browser-API surfaces have no replacement here.
- **One home Session per dot** — assignments are serial by design. Parallel work inside a dot needs subagents or several dots.
- **The assignment source is not `dot`** — the accepted message carries the Session controller's ordinary `user-rpc` source, so a consumer that needs to distinguish dot input by source must read the prompt text. Changing that needs a core Session event/source change this port deliberately avoids.
- **Archiving is not transactional** — a schedule that cannot be deleted, or a turn that cannot be cancelled, is reported in `warnings` while the record is still archived.
- **Subagent lineage follows live Sessions** — a subagent Session inherits its dot's policy while the ancestor chain is live; a cold ancestor ends the chain.
- **No model write-back** — a model changed later in the dot Session composer is not written to the record; the record keeps the creation-time selection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This note is working context, not a contract. The assignment prompt text, the guard messages, and the record checks are pinned by unit snapshots; changing them changes model-visible behavior and needs a recorded-session snapshot in the same change.

Open questions: whether a future core message source should carry dot identity instead of embedding it in the prompt text, and whether the Web GUI needs a `dots` Remote event stream rather than polling `list`.

</details>
