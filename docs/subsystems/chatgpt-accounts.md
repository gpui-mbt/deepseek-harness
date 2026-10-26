---
description: "The Sign in with ChatGPT account directory: credential records, the loopback authorization flow, the Responses API adapter, and per-model capability overrides."
kind: "subsystem"
---

# ChatGPT accounts

English | [中文](chatgpt-accounts.zh.md)

## Summary

`@deepseek-ai/dsh-llm-chatgpt` makes one ChatGPT subscription usable as a model provider. It owns three things: an account directory whose tokens live as `grant` records in the credential store, the Sign-in-with-ChatGPT authorization flow that fills those records, and a `chatgpt` provider route that speaks the OpenAI Responses API with the active account's access token. The model catalog is whatever the account's provider listing publishes, filtered to list-visible entries and admitted only when a context window is known; a profile override can supply or replace each capability. The route is dormant until an account connects, so the provider never advertises a model it cannot authenticate.

## Table of Contents

- [Account records](#account-records)
- [Host identity](#host-identity)
- [Authorization](#authorization)
- [Model catalog and capabilities](#model-catalog-and-capabilities)
- [Requests and replay](#requests-and-replay)
- [Failures](#failures)
- [Configuration](#configuration)
- [Cordis API](#cordis-api)

-----

<a id="account-records"></a>
## Account records

Every account is one credential record under the `dsh-chatgpt` scope, keyed `account-<uuid>`. Its payload is written only by this plugin and validated on read:

| Field | Meaning |
|---|---|
| `accountId` | The record key's account id, duplicated in the payload for validation. |
| `clientId` | The client registration OpenAI issued for this account; a new registration starts from the `dynamic_agent_client` placeholder and stores the issued id. |
| `subject` | The verified OIDC subject; a reauthorization must match it. |
| `email` | Present only when the ID token carried a verified email. |
| `grantGeneration` | Incremented by local sign-out; in-flight catalog loads and prepared calls compare it and refuse to mix generations. |
| `status` | `connected` (tokens present) or `needs-sign-in` (registration retained, no tokens). |
| `accessToken`, `refreshToken`, `idToken`, `expiresAt`, `scopes` | The offline grant, present only while connected. |
| `createdAt` | Stable creation time used for list order. |

The Client sees `ChatGptAccountView` values instead: label, verified email, status, active flag, and the account's admitted models. Tokens never appear in a Remote result, a log line, or a session event.

<a id="host-identity"></a>
## Host identity

One `dsh-chatgpt/host` record holds `{ version: 1, hostId: 'urn:uuid:<v4>' }`. The authorization request presents it as `ext_agent_host_id`, which is how the provider recognizes the installation across sign-ins. Activation repairs a legacy bare-UUID value in place and rejects anything that is not a v4 UUID.

<a id="authorization"></a>
## Authorization

`ChatGptHost` registers one `authorization` flow per saved account and starts a per-attempt loopback HTTP server bound to `127.0.0.1` on an ephemeral port. One attempt proceeds in four steps:

1. Build the authorize URL with PKCE `S256`, a fresh `state`, a fresh `nonce`, the required scopes (`openid`, `profile`, `email`, `offline_access`, `resource.invoke`, `chatgpt.tokens.use.direct`), and the API resource. The URL is published through the flow's notice, never returned as a token-bearing handle.
2. Serve `GET /auth/callback`. Only an attempt still awaiting the browser accepts one; `state` is compared in constant time, and a reauthorization also requires the callback's client id and the verified subject to match the saved registration.
3. Exchange the code and verify the returned ID token against the auth origin's published discovery document and JWKS: issuer equality, HTTPS and same-origin endpoints, audience, nonce, expiry, a non-empty subject, and `azp` when present.
4. Commit the record through `AuthorizationSession.commit`. An incomplete grant — a missing plan scope or no refresh token — commits a token-less `needs-sign-in` registration instead and fails the attempt with a message naming the missing permission.

Commit is the seam's write path, so the attempt's committing latch and the credential store's cross-process lock both apply. Before committing, the callback reads the record through a locked no-op write, because a plain read answers from the process snapshot and may not see another process's sign-out. That read also enforces the expected grant generation; a concurrent local sign-out or a second Host's change refuses the write. Cancellation before commit is effective: the flow's signal aborts the pending exchange and no record is stored.

Each attempt is bounded by `loginTimeoutMs`, retains its redacted view for ten minutes after finishing, and closes its loopback server on completion, cancellation, or failure. The Host aborts and drains every pending attempt during disposal.

<a id="model-catalog-and-capabilities"></a>
## Model catalog and capabilities

The catalog is `GET https://api.openai.com/v1/models` with the account's bearer token, filtered to `visibility: "list"` and cached per account in process memory. Loading is coalesced per account, bounded by `requestTimeoutMs`, aborted by account sign-out, and discarded when a newer load or an invalidation moves the account's epoch. `refreshModels` invalidates first and then reloads.

Capabilities come from two sources, in this order:

1. A profile `modelOverrides` row keyed by the exact slug may state the context window, input modalities, the accepted reasoning efforts, and the default effort.
2. Otherwise the package's frozen table of documented model facts supplies them.

A model with no context window from either source is not admitted: it stays unlisted and cannot be selected, and the provider page marks it as needing a window. An unknown model with only a context override is advertised with no declared input modalities, which the harness reads as "no image capability" rather than "unknown".

`resolveModel` re-reads the catalog, so a slug that is no longer list-visible fails with `UNKNOWN_MODEL`. `prepareCall` captures the account selection, overrides, and timeouts once, resolves metadata against that snapshot, refreshes the token, and revalidates the grant generation before returning. A profile change during resolution therefore cannot combine one account's catalog with another's token.

<a id="requests-and-replay"></a>
## Requests and replay

The adapter streams `POST https://api.openai.com/v1/responses` with:

- the full conversation as `input`, `store: false`, `stream: true`, and `include: ['reasoning.encrypted_content']`;
- tools as `additional_tools` developer items, either all up front when the tool history is incomplete or at each historical addition when it is complete;
- a terminal assistant message's stored output items replayed verbatim when its `replayState` matches the provider, model, and account;
- no `max_output_tokens`, `temperature`, or `stop`.

Streamed events map to `block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, and one terminal `finish` carrying the replay state. `response.completed` is required; a stream that ends first fails with `STREAM_CLOSED`. Streamed output items are ordered by `output_index`, must be contiguous from zero, and must agree with the terminal response's output types. A quiet stream for `streamIdleTimeoutMs` aborts the request with `STREAM_IDLE_TIMEOUT`.

<a id="failures"></a>
## Failures

| Condition | Result |
|---|---|
| No connected account, or a grant invalidated by refresh | `CHATGPT_SIGN_IN_REQUIRED` |
| Account record missing | `CHATGPT_ACCOUNT_MISSING` |
| Grant generation or saved registration changed mid-operation | `CHATGPT_ACCOUNT_CHANGED` |
| HTTP 401/403 | `AUTH` |
| HTTP 429 | `RATE_LIMIT` |
| Context-window rejection text | `CONTEXT_WINDOW_EXCEEDED` |
| HTTP 400/413 | `INVALID_REQUEST` |
| HTTP ≥ 500 | `SERVER` |
| The plan's exact `subscription_sharing_usage_limit_exceeded` code | preserved verbatim |
| Non-stream or malformed response | `OPENAI_RESPONSES_ERROR` / `MALFORMED_RESPONSE` |
| Unreplayable output item | `UNSUPPORTED_CONTENT`, naming only sanitized type names |
| Stalled stream | `STREAM_IDLE_TIMEOUT` |

`retry-after` is converted to `providerRetryAfterMs` for the shared retry layer; the SDK's own retries are disabled so retry ownership stays in `llm-retry`.

<a id="configuration"></a>
## Configuration

The generated [configuration catalog](../config-catalog.md#deepseek-aidsh-llm-chatgpt) owns every field. Two choices are worth stating here:

- `authorizeOnStart` is the only activation-time network path. With no connected account it starts the browser flow during `apply`, logs the authorization URL, and waits for the callback; a composition that cannot complete it fails the row rather than starting work without credentials.
- Persisted profile state (`activeAccountId`, `welcomeAcknowledged`, `modelOverrides`) is written through `configEditor`. A composition without it keeps reads working and rejects mutations.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxchatgptcontroller--chatgptcontroller"></a>

### `ctx.chatgptController` — `ChatGptController`

Typed Remote operations for profile ChatGPT accounts, catalogs and sign-in.

```ts cordis-catalog
/**
 * Read account, catalog and sign-in state without exposing credentials.
 * @returns the redacted account and OAuth-attempt snapshot.
 */
@Remote getState(): Promise<ChatGptState>

/**
 * Start a Host-owned OAuth callback and return the URL for the system browser.
 * @param request - a saved account for reauthorization, or an empty request for a new registration.
 * @returns the safe attempt handle and authorization URL.
 */
@Remote beginLogin(request: ChatGptLoginRequest): Promise<ChatGptLoginTicket>

/**
 * Cancel an unfinished local sign-in attempt.
 * @param request - opaque attempt handle returned by {@link beginLogin}.
 */
@Remote cancelLogin(request: ChatGptCancelLoginRequest): Promise<void>

/**
 * Select the profile's ChatGPT account for future model requests.
 * @param request - the saved account to activate.
 */
@Remote setActiveAccount(request: ChatGptAccountRequest): Promise<void>

/**
 * Remove an account and revoke its refresh token when possible.
 * @param request - account to disconnect.
 * @returns whether OpenAI confirmed token revocation.
 */
@Remote signOut(request: ChatGptAccountRequest): Promise<ChatGptSignOutResult>

/**
 * Refresh one saved account's list-visible model catalog.
 * @param request - account whose catalog should be refreshed.
 * @returns the updated redacted state.
 */
@Remote refreshModels(request: ChatGptAccountRequest): Promise<ChatGptState>

/**
 * Store or clear one profile capability override.
 * @param update - exact account catalog slug and its replacement override.
 * @returns updated redacted state.
 */
@Remote setModelConfig(update: ChatGptModelConfigUpdate): Promise<ChatGptState>

/** Remember that a Client has shown the initial account welcome view. */
@Remote acknowledgeWelcome(): Promise<void>
```

Source: [`packages/llm/llm-chatgpt/src/index.ts`](../../packages/llm/llm-chatgpt/src/index.ts)
<!-- END GENERATED cordis-surface -->

## Known Limitations and Deferred Work

- **Provider capability facts are source data.** The documented model table is a snapshot; a slug the table does not know needs a profile override with at least a context window.
- **One active account.** The route authenticates with one selected account; there is no per-model account routing.
- **No usage reporting.** The adapter reports request token usage, not plan quota; the provider page links to the plan's own usage view.
- **Process-local catalog.** The cache is not persisted, so a restart re-reads the provider listing.
