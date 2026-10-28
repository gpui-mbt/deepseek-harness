---
description: "Model-facing dot_create, dot_list, dot_assign, dot_update, dot_schedule, and dot_archive tools over the dots controller."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-dots

English | [中文](README.zh.md)

## Summary

`dsh-tool-dots` gives the model six tools for persistent named agents: create a dot, list dots with live status, queue an assignment, change a dot's purpose or memory, schedule recurring work, and archive a dot. Every tool is a thin adapter over the `dotsController` service that [`@deepseek-ai/dsh-dots`](../dots/README.md) mounts, so validation and lifecycle rules stay in one place. The package holds no dot state and needs no configuration; mounting it adds the tools to the calling scope, and a preset decides which agents receive them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this package in any composition that also mounts [`@deepseek-ai/dsh-dots`](../dots/README.md); the plugin injects `tools` and `dotsController`, so it stays inert until both exist. It has no `Config`. Registration is scoped to the mounting context, so a preset can hand the tools to one agent and withhold them from another.

| Tool | Purpose |
|---|---|
| `dot_create` | Create a dot with a name, purpose, agent preset, permission preset, allowlist, and optional provider/model/reasoning effort. |
| `dot_list` | List dots with live status (`running`, `idle`, `asleep`, `missing`), optionally including archived dots. |
| `dot_assign` | Queue one task on a dot; the call returns on acceptance, not completion. |
| `dot_update` | Replace the purpose, append a dated memory note, or replace the execution allowlist. |
| `dot_schedule` | Create a durable schedule with exactly one timing selector. |
| `dot_archive` | Stop active schedules, cancel the running turn, and archive the dot. |

A dot reference is its exact id or its case-insensitive name. The tools never select a host: a dot belongs to the host running this plugin.

### What a call returns

`dot_create` returns the created dot and any non-fatal warnings, such as a Workspace registration that failed while the dot directory and home Session succeeded. `dot_list` returns the dots with their status. `dot_assign` returns the dot id and home Session id with `status: "queued"`. `dot_update` returns the updated dot. `dot_schedule` returns the schedule id, kind, title, and next occurrence. `dot_archive` returns the number of deleted schedules plus any warnings for schedules that could not be deleted or a turn that could not be cancelled.

### Argument validation

The tool schemas validate shapes; the package additionally rejects the cases a schema cannot express. `dot_create` requires `provider` and `model` together. `dot_schedule` validates the JSON selector objects it receives: `at` accepts an RFC 3339 string or `{date, time, time_zone}`, `daily` requires `{time, time_zone}`, `weekly` requires `{time, time_zone, weekdays}` with ISO weekdays 1 through 7, and `cron` requires `{expression, time_zone}`. A malformed selector fails before any state changes.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

The tools are a pure factory: [`defineDotTools`](src/tools.ts) takes the service operations it calls and returns complete definitions, so registration is the only effect and every call is testable without a Cordis context. Model-facing text is written from the model's perspective: descriptions explain what a dot is for and what a call does, and never mention hosts, RPC, or storage.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `name`, `inject`, `apply` |
| [`src/tools.ts`](src/tools.ts) | The six definitions, selector validation, and JSON-safe result projection |

### Export shape

The plugin is a function plugin: it exports `name`, `inject`, and `apply`, with no default export and no `Config`. The `inject` list requires `tools` and `dotsController`; a composition missing either leaves the row unloaded rather than registering partial tools.

### Result projection

Remote results carry readonly arrays and branded identifiers. A tool result must be lossless JSON, so [`src/tools.ts`](src/tools.ts) projects each dot into a detached JSON object with copied arrays before returning it, and returns primitive-only summaries for the other calls. This keeps the model-facing payload stable when the service adds fields.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [dots](../dots/README.md) — the `dotsController` service, storage domain, and tool guard behind these tools.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-dots) — the exact schemas the model receives.
- [tool-todo](../../todo/tool-todo/README.md) — another registration-scoped tool package and its Model Experience format.
- [Adding a tool](../../../docs/cookbook/adding-a-tool.md) — UI presentation and result-metadata guidance.

## Model Experience

### Tool schemas

#### What the model sees

The model sees the six generated schemas linked from the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-dots). Each description states the dot lifecycle rule that matters for the call: `dot_assign` returns on acceptance, `dot_schedule` requires exactly one selector, and `dot_archive` stops schedules and cancels the running turn.

#### Token effect

Fixed schema cost on every request where the tools are visible; the schemas are static for a given package version and registration scope.

#### KV Cache effect

Prefix-stable while visibility and scope are unchanged. A preset change that adds or removes the tools invalidates reuse from the schema block onward.

### Tool results

#### What the model sees

Each successful call returns pretty-printed JSON: the created or updated dot for `dot_create` and `dot_update`, the dot list for `dot_list`, `{"accepted": true, "dotId": ..., "sessionId": ..., "status": "queued"}` for `dot_assign`, the schedule summary for `dot_schedule`, and the archive summary with `deletedSchedules` and optional `warnings` for `dot_archive`. A failure returns `Error: <message>` and changes nothing.

#### Token effect

Result tokens scale with the number of dots listed and with the size of one dot record; assignment and archive results are small and fixed-shape.

#### KV Cache effect

Append-only: results are tool messages appended after the reusable request prefix, so a call never invalidates earlier cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No dot read-back tool** — `dot_list` is the only inspection call; there is no `dot_show` for one dot's contract or memory. Add one when a consumer needs it rather than widening `dot_list`.
- **Tools never choose a host** — every call addresses the host running the plugin; a multi-host surface would need a routing argument and a resolved fleet, which this port deliberately omits.
- **Selector validation lives in the tool** — `dot_schedule` validates `at`, `daily`, `weekly`, and `cron` JSON, so the service must stay usable by other Remote callers that validate their own input.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This note is working context, not a contract. Descriptions and result renderings are model-visible text: changing them needs a recorded-session snapshot in the same change, and the tool-catalog anchor only resolves after the generator runs for this package.

Open question: whether `dot_list` should gain a compact form once a fleet exists; a fleet is outside this port's scope, so no design exists yet.

</details>
