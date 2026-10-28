# Agent Note: Persistent dots are in-box packages

Status: implemented

English | [中文](2026-10-26-dots-in-box.zh.md)

## Problem

[dsh-dots](https://github.com/f4ah6o/dsh-dots) shipped as an external bundle: its own workspace, its own `@f12o` package, a browser API route next to the Remote plane, a `hosts.json` fleet registry, and a peer transport that mirrored records between hosts. Every DSH pre-release forced the package to re-pin peer versions, and the client talked to `/dots/api` through bespoke fetch envelopes instead of the Typert Remote surface every other panel uses.

Moving the capability in-box raised four questions the external layout had answered differently: where a multi-host lifecycle lives once the product is single-host; how the retired file registry becomes durable storage without losing records; how an assignment is delivered when the in-box prompt API has one message source; and how the execution guard covers descendants of a dot.

## Decision

### Single host, Web app rows

`@deepseek-ai/dsh-dots` mounts in `packages/bundle/web-app/cordis.patch.yml` after `session-controller`, with `@deepseek-ai/dsh-tool-dots` beside it; both need the Session controller, which only the Web host composes. The peer/fleet plane is gone: no `hosts.json`, no `host` argument, no remote selection, no mirroring. A dot is owned by the host that stores it, and the records stay in that host's storage domain. The client panel ships as `@deepseek-ai/dsh-client-ui-dots` in the same bundle.

### Records move to a storage domain with a one-time import

Records live in the `dots` storage domain, version 1, one table keyed by `DotId`, validated by the same decoder the file registry used. The first activation imports `$DSH_HOME/dots/registry.json` while the table is empty and renames the file `registry.json.imported`; a file that survives beside a non-empty table is logged and left untouched. Nothing merges silently and nothing deletes user data, so a failed import is recoverable by renaming the file back.

### Assignments are queued prompts

`sessionController.prompt({ mode: 'queue' })` is the only in-box delivery path. The prompt frame carries the dot name and id, purpose, assignment id, caller, the bounded `MEMORY.md` tail, and the task; `lastAssignedAt` and `assignmentCount` are recorded only after acceptance. The in-box prompt API records the ordinary `user-rpc` message source, so the dot id rides in the text instead of a `source.kind === 'dot'` event. Adding a new source would change the Session format for one consumer; the trade is a text-carried identity for an unchanged format.

### The guard extends to a dot's descendants

The external guard denied `dot_*` and enforced `allowedTools` for a dot's home session only. In-box, the guard resolves a live session's lineage through a `parentSessions` port and applies the dot's allowlist to subagent sessions descended from it; a dot still cannot manage dots. This closes a path the external contract described but did not implement.

### Remote surface is deliberately small

The `dotsController` Remote service exposes `list`, `create`, `assign`, `update`, `archive`, `scheduleList`, and `scheduleCreate` — the operations the panel and the tools both need. Model selection is accepted by `create` and validated against the live catalog, but no Remote method publishes the catalog: the Web panel uses the deployment defaults, and a browse UI stays deferred.

## Alternatives considered

- **Keep the peer/fleet plane behind a flag.** The product has no second-host owner or transport; the flag would preserve untested code and the browser API route that bypasses the Remote plane.
- **Keep the file registry and add a storage mirror.** Two authorities for one record invite divergence; the one-time import gives a single authority and a reversible cutover.
- **Add a `dot` message source.** It would make the identity typed, but changes the Session format for one producer; the prompt frame keeps the format stable.
- **Publish the model catalog over Remote.** Useful for a picker, but the external panel's model browser was the largest part of the port and no in-box consumer needs it yet.
- **Keep the HTTP `/dots/api` route.** The Remote namespace already carries auth, cancellation, and typed errors; a second route would duplicate the authorization surface.

## Consequences

- The external bundle must be removed before the in-box rows mount; two `dotsController` registrations fail loudly. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/dots-in-box/guide.md) owns the migration and the registry import.
- Storage has one authority, and a corrupt row rejects opening the domain instead of entering the lifecycle.
- The guard covers subagent descendants, which the external source documented but did not implement.
- The model picker, host selector, and peer plane are deferred; the panel uses deployment defaults and one host.
- Client-side Japanese copy lives in `@deepseek-ai/dsh-client-locale-ja`, matching every other namespace.
