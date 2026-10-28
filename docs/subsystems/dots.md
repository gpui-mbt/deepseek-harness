---
description: "Persistent named agents: durable dot records, private workspaces and home sessions, assignment framing, memory files, the execution-time tool allowlist, and the dots Remote API."
kind: "subsystem"
---

# Dots

English | [中文](dots.zh.md)

## Summary

A dot is a durable named agent for work that continues across assignments. `@deepseek-ai/dsh-dots` owns the dot lifecycle — creation of a directory, workspace, and home session; delivery of an assignment through the Session controller; the managed `AGENTS.md` contract and bounded `MEMORY.md`; status derived from the Session list; archival; and durable schedules — while `@deepseek-ai/dsh-tool-dots` exposes the six model-facing tools. Records live in the `dots` storage domain, and the retired `$DSH_HOME/dots/registry.json` is imported once at activation. One host owns the whole lifecycle; there is no peer or fleet plane.

## Table of Contents

- [Records and storage](#records-and-storage)
- [Creation](#creation)
- [Assignment delivery](#assignment-delivery)
- [Status](#status)
- [Workspace files](#workspace-files)
- [Execution-time tool policy](#execution-time-tool-policy)
- [Schedules](#schedules)
- [Remote API](#remote-api)
- [Cordis API](#cordis-api)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="records-and-storage"></a>
## Records and storage

One domain named `dots` (version 1) holds one table named `dots`, keyed by `DotId` and valued by the complete `DotRecord`: display name, purpose, directory, home session id, optional workspace id, agent preset, optional permission preset, optional tool allowlist, optional model selection, creation and update instants, last-assignment instant and count, and an optional archive instant.

Every stored row is decoded with the same validation the retired file registry applied — exact id shape, non-empty name and purpose, absolute directory, declared presets, byte bounds, and non-negative counters — so a malformed row rejects opening the domain instead of entering the lifecycle. At activation, a legacy `$DSH_HOME/dots/registry.json` is imported only while the table is empty, then renamed `registry.json.imported`; a file that survives beside a non-empty table is logged and left untouched.

<a id="creation"></a>
## Creation

Creation validates the name (64 characters, no path separators or control characters), the purpose byte bound, the tool allowlist, and the requested preset and model against the deployment allowlists, then mints `dot-<slug>-<hex>` and creates `<root>/<dot-id>/` with its managed files. It registers a Workspace for that directory when the registry is mounted, creates the home session with the requested preset, titles it after the dot, applies the permission preset, and selects the requested model. A failed Workspace registration or rename is reported as a warning; a failed session creation removes a directory that produced neither a Workspace nor a session and reports the surviving path otherwise.

The root defaults to `$DSH_HOME/dots`. `maxDots` bounds active records; an archived dot does not count.

<a id="assignment-delivery"></a>
## Assignment delivery

An assignment resumes the home session through the Session controller and queues exactly one prompt in `queue` mode, so a running dot receives the work on a later turn and one dot processes assignments serially. The prompt is framed as a `[DOT ASSIGNMENT]` block carrying the dot name and id, the purpose, an assignment id, the caller, the bounded tail of `MEMORY.md`, the task bytes bound, and the instruction to report completion. `lastAssignedAt` and `assignmentCount` are recorded only after the prompt is accepted.

The in-box prompt API records the ordinary `user-rpc` message source, so the dot id travels inside the prompt text rather than in a `source.kind === 'dot'` session event. That choice keeps the Session format unchanged at the cost of a text-carried identity.

<a id="status"></a>
## Status

One `sessionController.list` read derives each dot's status: `running` while the home session is in a turn, `idle` when its agent is live but not running, `asleep` when only the durable record remains, and `missing` when the record points at a session the controller does not know. Status is read, never persisted.

<a id="workspace-files"></a>
## Workspace files

Every dot directory contains:

| File | Owner | Meaning |
|---|---|---|
| `AGENTS.md` | managed | The operating contract: purpose, autonomy, memory and reporting rules, preset, permission preset, and the allowlist summary. Rewritten when the purpose or allowlist changes. |
| `MEMORY.md` | dot and updater | Dated durable facts appended through `dot_update`; only a bounded tail enters one assignment. |
| `.dsh-dot/manifest.json` | managed | Id, name, and creation instant for dashboards and repair. |
| `report.md`, `NEEDS_ATTENTION.md` | dot | Optional completion detail and the escalation channel named by the contract. |

`maxMemoryBytes` bounds the tail injected into an assignment; truncation keeps a visible `(older memory omitted)` marker.

<a id="execution-time-tool-policy"></a>
## Execution-time tool policy

When `enforceToolAllowlist` is true, a `tools/pre-execute` listener denies a tool for a dot's home session unless the tool matches the dot's allowlist: exact names or trailing `*` prefixes, with an empty list allowing no tools and an omitted list allowing everything. The guard also denies every `dot_*` tool inside a dot, refuses archived dots, and applies the same allowlist to a live subagent session whose lineage reaches a dot. The denial reason names the dot and the allowed patterns so the model can recover.

<a id="schedules"></a>
## Schedules

`dot_schedule` and the `scheduleList`/`scheduleCreate` Remote methods bind durable schedules to the dot's home session. The Schedule service is optional; without it these operations fail with `dots/unavailable` and the rest of the lifecycle keeps working. Archiving a dot stops its schedules by default.

<a id="remote-api"></a>
## Remote API

The service mounts as `ctx.dotsController` and binds the Typert Remote namespace `dots`: `list`, `create`, `assign`, `update`, `archive`, `scheduleList`, and `scheduleCreate`. A dot reference is its exact id or its case-insensitive name. Every mutating method accepts an optional trailing signal for caller cancellation, and the Web panel uses the same operations the model tools do.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdotscontroller--dotscontroller"></a>

### `ctx.dotsController` — `DotsController`

Remote API over one deployment's durable dots.

```ts cordis-catalog
/**
 * List dots with live status.
 * @param request - whether to include archived records.
 * @param signal - optional caller cancellation.
 * @returns visible dots in storage order.
 */
@Remote('list') async list(request: DotsListRequest, signal?: AbortSignal): Promise<DotsListValue>

/**
 * Create one dot with its workspace directory and home session.
 * @param request - name, purpose, and optional preset/permissions/model.
 * @param signal - optional caller cancellation.
 * @returns the created dot and non-fatal warnings.
 */
@Remote('create') async create(request: DotsCreateRequest, signal?: AbortSignal): Promise<DotsCreateValue>

/**
 * Queue one assignment on a dot's home session.
 * @param request - dot reference, task text, and optional caller identity.
 * @param signal - optional caller cancellation.
 * @returns acceptance, not completion.
 */
@Remote('assign') async assign(request: DotsAssignRequest, signal?: AbortSignal): Promise<AssignResult>

/**
 * Update one dot's purpose, memory, or execution allowlist.
 * @param request - dot reference and the changes to apply.
 * @param signal - optional caller cancellation.
 * @returns the updated dot.
 */
@Remote('update') async update(request: DotsUpdateRequest, signal?: AbortSignal): Promise<DotView>

/**
 * Archive one dot, stopping its schedules and live turn.
 * @param request - dot reference and whether to stop its schedules.
 * @param signal - optional caller cancellation.
 * @returns the archive summary.
 */
@Remote('archive') async archive(request: DotsArchiveRequest, signal?: AbortSignal): Promise<ArchiveResult>

/**
 * List one dot's active schedules.
 * @param request - dot reference.
 * @param signal - optional caller cancellation.
 * @returns active schedules bound to the dot's home session.
 */
@Remote('scheduleList') async scheduleList(request: DotsScheduleListRequest, signal?: AbortSignal): Promise<DotsScheduleListValue>

/**
 * Create one durable schedule on a dot's home session.
 * @param request - dot reference plus title, prompt, and exactly one timing selector.
 * @param signal - optional caller cancellation.
 * @returns the created schedule summary.
 */
@Remote('scheduleCreate') async scheduleCreate(request: DotsScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleResult>
```

Source: [`packages/dots/dots/src/service.ts`](../../packages/dots/dots/src/service.ts)
<!-- END GENERATED cordis-surface -->

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Single host.** A dot is owned by the host that stores it; there is no peer transport, fleet merge, or remote selection.
- **Text-carried dot identity.** Assignments use the ordinary user message source, so the dot id lives in the prompt frame instead of a dedicated session event.
- **Model selection is validated but not browsable.** `create` accepts an explicit provider/model pair; no Remote method publishes the live catalog.
- **Memory is one file.** Concurrent memory appends serialize through the controller, and only a byte-bounded tail reaches an assignment.
- **Schedules need the Schedule service.** Without it, schedule operations fail loud and the rest of the lifecycle continues.
