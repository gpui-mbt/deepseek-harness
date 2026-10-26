---
description: "The Dots page on the dsh web client: persistent named agents, their live session status, assignments, memory, allowed tools, and schedules."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-dots

English | [中文](README.zh.md)

## Summary

Open **Dots** in the sidebar to see every persistent named agent in this deployment, its live Session status, and the work already assigned to it. Select one to queue an assignment, append durable memory, edit its execution allowlist, review or add schedules, and open its home Session in the current window. New dots are created from the deployment defaults, so the page carries no host picker and no model catalog. Every control calls the Host's `dots` Remote namespace and renders the returned record; the page stages nothing locally.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open the Dots entry beside the Conversation and Automation panels; the page lists every dot with a status chip, its purpose, and its assignment count.

**New dot** takes a name and purpose plus optional agent preset, permission preset, and execution allowlist. The Host applies the deployment's model default, creates the dot directory, and registers its workspace and home Session, so the form has no model selection of its own. **Refresh** re-reads the list after work done outside this page.

The detail pane offers **Open Session**, which reveals the dot's home Session through the Workspace navigation; **Assign work**, which queues one task and reports acceptance rather than completion; **Remember**, which appends one durable memory line; and **Allowed tools**, which replaces the execution allowlist with a comma-separated list. Saving requires at least one name or trailing-`*` prefix because an empty list would deny every tool.

**Schedules** lists the dot's active schedules and creates a one-shot schedule that runs after a whole number of seconds. **Archive** asks for confirmation and then stops the dot's schedules while its files and history remain.

<a id="understand-the-implementation"></a>
## Understand the implementation

The browser half registers two slots. Its `main` entry uses the `dots` key and renders the page for every dot in the deployment; its `sidebar.panellist` entry uses the same id at order 20 and supplies the dot-grid glyph and the **Dots** label. Both registrations are effects of the plugin fiber, so unloading removes the page and the entry together.

`DotsPanel` receives one inject face built in `apply`: the `dots` Remote namespace and an `openSession` callback that delegates to `ctx.uiWorkspace.openSession`. That navigation call retains and loads the Session, so a dot whose home Session is cold opens the same way a listed Session does.

The page keeps all state in local React state. The mount effect reads the list once, the selection effect reads that dot's schedules, and mutations apply the record the Host returns; only an accepted assignment re-reads the list because its result carries no updated view. A failed Remote result becomes the operation's own localized sentence, and an unexpected rejection is reported with the same sentence, so Remote messages never reach the page.

Copy lives in the typed `dots` locale namespace with English and Simplified Chinese dictionaries. The package consumes `@deepseek-ai/dsh-client-ui-primitives` for its buttons, status chips, and archive dialog, and styles the rest through a CSS Module that reads only `--dsw-alias-*` tokens.

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-dots`](../../dots/dots/README.md) — durable dot records, the home Session, the guard, and the `dots` Remote namespace.
- [`@deepseek-ai/dsh-tool-dots`](../../dots/tool-dots/README.md) — the model-facing tools that create, assign, and schedule dots.
- [`@deepseek-ai/dsh-client-ui-workspace`](../ui-workspace/README.md) — Session navigation and directory browsing behind `ctx.uiWorkspace`.
- [Slots reference](../../../docs/subsystems/slots.md) — the `main` and `sidebar.panellist` contracts this package registers into.

<a id="model-experience"></a>
## Model Experience

None, as the dots page renders and mutates Host-held records without contributing model context or Session events.

#### KV Cache effect

None; the package sends no model request and changes no cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The page waits for the Host namespace.** Mounting this package without `@deepseek-ai/dsh-dots` leaves both entries pending on `remote.dots`; no page, label, or glyph appears.
- **No host selector and no model picker.** The single-host design means creation always uses the deployment defaults; a per-dot model route can only be chosen by the model-facing tool that accepts one.
- **Schedule creation is one-shot only.** The page submits `after_seconds`; daily, weekly, cron, and wall-clock targets remain available through the model-facing schedule tool.
- **The allowlist cannot be cleared back to unrestricted.** The Remote `update` method treats an omitted list as unchanged and an empty list as deny-all, so the page requires at least one pattern.
- **The list is read on mount, not subscribed.** No forwarded event or poll updates it; use **Refresh** to re-read status and assignment counts.
- **Name validation belongs to the Host.** A duplicate or invalid name surfaces as the generic create failure rather than a field-level message.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
