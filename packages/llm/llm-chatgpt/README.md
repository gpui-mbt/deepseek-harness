---
description: "ChatGPT subscription inference for DeepSeek Harness: a Sign in with ChatGPT account directory, one Responses API provider route, and per-model capability overrides."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-chatgpt

English | [中文](README.zh.md)

## Summary

Sign in with a ChatGPT account and use it as a model provider. The Host owns one account directory whose grants live in the credential store, one `chatgpt` route backed by the OpenAI Responses API, and the profile state the provider page edits: the active account and per-model capability overrides. The route mounts dormant: with no connected account it advertises no models, so a fresh installation shows nothing to select. OAuth runs in the system browser through the `authorization` seam; the callback binds one loopback port, and tokens never reach the Client, the session log, or a Remote result.

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

Mount one `llm-chatgpt` row where `credentials`, `authorization`, and `llm` are already composed. `dsh-base` carries it by default. Open **Plugins → ChatGPT** in the web GUI, choose **Continue with ChatGPT**, approve access in the browser, and the route starts listing the models that account can use. `dsh-base` also carries the row in headless profiles: a headless task without an account reports `CHATGPT_SIGN_IN_REQUIRED` until one is connected through a web profile that shares the same `$DSH_HOME`.

The provider page connects or reauthorizes accounts, switches the active account, refreshes the list-visible catalog, and stores per-model capability overrides. A second account is usable only after the user selects it: with several connected accounts and no saved selection the route refuses to guess. Setting `authorizeOnStart: true` in a profile patch starts the same browser sign-in during Host activation when no connected account exists, waits for the callback for up to `loginTimeoutMs`, and fails the row when it does not complete; the authorization URL is written to the log.

| Config field | Default | Meaning |
|---|---|---|
| `activeAccountId` | unset | Saved active account; written by the provider page. |
| `welcomeAcknowledged` | `false` | Whether the first-connection welcome was shown. |
| `authorizeOnStart` | `false` | Start the browser sign-in during activation when no account is connected. |
| `modelOverrides` | `[]` | Per-slug context window, input modalities, reasoning efforts, and default effort. |
| `requestTimeoutMs` | `10000` | Deadline for one OAuth or catalog request. |
| `loginTimeoutMs` | `300000` | Lifetime of one loopback sign-in attempt. |
| `loginPollIntervalMs` | `1000` | Client poll interval while a callback is pending. |
| `streamIdleTimeoutMs` | `120000` | Quiet period after which a stalled response stream fails; `0` disables the check. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-chatgpt) is the exhaustive source for every accepted field and its JSDoc.

<a id="understand-the-implementation"></a>
## Understand the implementation

**Accounts and grants.** Each account is one `grant` credential record under scope `dsh-chatgpt`: client id, verified subject, the offline grant, and a `grantGeneration` counter that invalidates in-flight work after a local sign-out. A separate `dsh-chatgpt/host` record holds the installation's `urn:uuid:` host id, which the authorization request presents as `ext_agent_host_id`. Legacy records that stored that id without the prefix are repaired in place during activation.

**Authorization.** `ChatGptHost` registers one `authorization` flow per saved account and starts a per-attempt loopback server on `127.0.0.1`. The callback validates `state`, exchanges the code with the captured PKCE verifier, verifies the signed ID token through the auth origin's published JWKS (issuer, audience, nonce, expiry, subject, and `azp` when present), and commits the record through `AuthorizationSession.commit`. An incomplete grant — a missing plan scope or no refresh token — stores the verified registration without tokens and reports a failed attempt, so the next sign-in can reauthorize the same account. A fresh sign-in validates the record it is replacing and the expected grant generation before committing, which is why a concurrent sign-out or a second Host's account change refuses the write.

**Requests.** The adapter sends the Responses API a full conversation per turn with `store: false`, `stream: true`, and `include: ['reasoning.encrypted_content']`. Tools travel as `additional_tools` developer items rather than the top-level `tools` field, and each assistant message replays the output items stored in its `replayState` when the provider, model, and account still match. Streamed events map to the harness block vocabulary; a terminal `response.completed` is required, and streamed and terminal output items must agree. Usage becomes a token-usage chunk only when the provider counters are complete and internally consistent.

**Failures.** Provider HTTP failures map to the shared LLM codes (`AUTH`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `SERVER`), keep the plan's exact `subscription_sharing_usage_limit_exceeded` code, and preserve `retry-after`. A `invalid_grant` refresh fails the record down to `needs-sign-in` and reports `CHATGPT_SIGN_IN_REQUIRED`; signing out aborts in-flight account work before writing the token-less record.

<a id="further-exploration"></a>
## Further Exploration

- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the adapter and stream-chunk contract this route implements.
- [ChatGPT accounts subsystem](../../../docs/subsystems/chatgpt-accounts.md) — the account records, sign-in flow, and model capability rules.
- [Credentials subsystem](../../../docs/subsystems/credentials.md) — the record store and reference resolution.
- [Authorization seam](../../../packages/credentials/authorization/README.md) — flows, notices, and commit semantics.
- [`@deepseek-ai/dsh-client-ui-chatgpt`](../../client/ui-chatgpt/README.md) — the provider page and composer notice.

<a id="model-experience"></a>
## Model Experience

None, as the adapter translates requests the agent loop already assembled and adds no prompt, tool, or result text of its own.

#### KV Cache effect

The route resends the full conversation each turn and preserves the provider's prompt-prefix reuse; a model, account, or replay-state mismatch drops replayed reasoning items for the affected message, which invalidates prefix reuse from that point.

## Known Limitations and Deferred Work

- **One request image projection.** Images travel as base64 data URLs at their normalized size; the route declares no route-specific image budget, so the loop's offload policy is the only bound.
- **No provider output cap.** The Responses call never sends `max_output_tokens`, so a caller's `maxTokens` is rejected rather than honored and the token meter has no default output cap to report.
- **Plan capability table in source.** The seven known model slugs and their published limits live in `src/models.ts` with the documentation URLs they came from; a new model is selectable only after its facts are added or a profile override supplies a context window.
- **Account selection is explicit.** A saved `activeAccountId` that matches no connected account leaves the route signed out rather than falling back to the sole account.
- **Profile edits need an editable profile.** Switching accounts, saving overrides, and acknowledging the welcome write through `configEditor`; a composition without it keeps reads working and rejects those mutations.
- **Catalog cache is process-local.** A Host restart re-reads the account catalog from the provider.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
