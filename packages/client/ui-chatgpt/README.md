---
description: "The ChatGPT provider page on the dsh web client's Plugins page and the composer plan notice it contributes."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-chatgpt

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **ChatGPT** in the Official group to connect a ChatGPT account, switch the active account, refresh the model list the account can use, and set per-model capabilities. The page stages nothing locally: every control calls the Host's `chatgpt` Remote namespace and renders the snapshot it returns, so two open pages agree. A composer dock entry marks a Session that currently routes to ChatGPT and surfaces the plan usage-limit notice of the latest failed turn. The page exists only while the Host provides the namespace.

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

**Continue with ChatGPT** opens the authorization page in a tab it preopens on the click, so a blocked popup leaves the visible link as the fallback. While a callback is pending the page polls the Host snapshot at `loginPollIntervalMs`, shows the attempt phase, and offers cancel; leaving the page cancels attempts it started. Provider tabs keep `window.opener` isolated. Browser policy can refuse parent-driven tab closure after cross-origin navigation, so popup cleanup is best effort and cannot prevent Host cancellation or teardown. Only a Host-confirmed cancelled attempt displays the conditional instruction to close a remaining sign-in tab manually; a failed cancel stays retryable and must not claim success. Cancellation closes the Host callback listener, so a late browser callback cannot create credentials. The account list marks `Connected`, `Registration required`, or `Sign-in required`; only a connected account can become active, and the page never chooses between several connected accounts on its own.

**Available models** lists what the account's catalog currently publishes. A model without a context window is marked as needing one: open it, set the window, and save. The editor also stores input modalities, the reasoning efforts the model accepts, and their default; **Use official model defaults** removes the override. Refreshing re-reads the provider catalog and keeps the saved overrides.

**Sign out** asks the Host to revoke the refresh token and then removes local tokens; when revocation was not confirmed the page says so and keeps the registration so the account can sign in again.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin registers into two slots. Its `plugins.item` entry renders the page for the `chatgpt` namespace; `view: 'summary'` returns the one-line description and `view: 'page'` the full page. Its `conversation.composer.dock` entry receives the Session binding, folds the Session's event window into a usage-limit snapshot, and reuses one observable per binding so a remount re-reads the same fact. Both registrations are effects of the plugin fiber, so unloading removes the page, the notice, and every pending-attempt tracker.

Copy lives in the typed `chatgpt` locale namespace, which the Japanese pack also translates; the page never renders a Host error message verbatim, only its own localized failure text.

<a id="further-exploration"></a>
## Further Exploration

- [ChatGPT accounts subsystem](../../../docs/subsystems/chatgpt-accounts.md) — account records, sign-in, catalog, and capabilities.
- [`@deepseek-ai/dsh-llm-chatgpt`](../../llm/llm-chatgpt/README.md) — the Host provider, Remote namespace, and configuration.
- [Slots reference](../../../docs/subsystems/slots.md) — the registration and props model used here.

<a id="model-experience"></a>
## Model Experience

None, as the provider page and composer notice render account state without contributing model context or Session events.

#### KV Cache effect

None; the package does not modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The page requires the Host namespace.** Mounting this package without `@deepseek-ai/dsh-llm-chatgpt` leaves the entry waiting for `remote.chatgpt`; no page, summary, or notice appears.
- **Usage limits are Session-local.** The composer notice reads the current Session's event window, so another Session's limit does not surface here.
- **Capability edits are per profile.** Overrides are stored in the plugin's profile configuration; a headless profile sharing the same installation does not inherit them unless it reads the same profile patch.
- **No account removal.** Sign-out keeps the registration on purpose; deleting a registration is a credentials-store operation outside this page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
