# Agent Note: The ChatGPT provider is an in-box package

Status: implemented

English | [中文](2026-10-26-chatgpt-provider-in-box.zh.md)

## Problem

[Sign in with ChatGPT](https://github.com/f4ah6o/dsh-SIWC) shipped as an external bundle: its own workspace, its own `@f12o` package, a patched `@deepseek-ai/dsh-typert-generator`, a bespoke client bundler with an SVG-inlining CSS pass, and a preflight row whose only job was turning a missing injected service into a startup failure. Users had to install it before the provider existed, and every DSH pre-release forced the package to re-pin peer versions.

Moving the capability in-box raised four questions the external layout had answered differently: where the provider mounts when it needs credentials but not the browser; how a sign-in commits without re-implementing the authorization seam's cancellation latch; how a client package reaches the Remote namespace without mounting its own descriptors; and how the adapter replays Responses output items without importing an undocumented SDK module.

## Decision

### Provider in `dsh-base`, page in `dsh-web-app`

`@deepseek-ai/dsh-llm-chatgpt` mounts in `packages/bundle/base/cordis.patch.yml` right after `llm`, and `@deepseek-ai/dsh-client-ui-chatgpt` mounts as a browser row in `dsh-web-app`. The route mounts dormant: it registers `chatgpt` immediately but advertises no models until an account connects, so `listModels` answers `[]` instead of throwing and a fresh installation never shows a failing provider group. The browser package registers a Plugins-page card rather than a Settings section, because a provider's account and capability state is configuration of one namespace.

### Sign-in commits through the authorization seam

The flow builds the record and calls `AuthorizationSession.commit`, so the seam's committing latch, its cancellation rules, and the credential store's cross-process lock all apply; the plugin no longer maintains its own committing flag. Because a plain credential read answers from the process snapshot, the callback reconciles the record through a locked no-op write before committing, which is what lets a concurrent local sign-out or another Host's change refuse the write. Once commit begins, cancellation waits for it, which is the seam's documented contract.

### Remote namespace mounts centrally

`@deepseek-ai/dsh-api-remotes` imports `@deepseek-ai/dsh-llm-chatgpt/remote` and mounts it with every other contribution. The browser package therefore waits on `remote.chatgpt` instead of running a child plugin that calls `$mount`, and client specs can drive the namespace through the test runtime rather than booting real descriptors.

### Replay items are serialized locally

The Responses API returns the same JSON vocabulary it accepts for the replayed item types, so `replayableOutputItem` switches on the discriminator string, accepts `message`, `function_call`, `reasoning`, `compaction`, and the wire-only `configuration_update`, and validates each through the same predicate that guards stored replay state. The OpenAI SDK's internal `lib/responses/ResponseInputItems` import disappears, the SDK version can move independently, and unreplayable types still fail with a sanitized type list.

### Provider hooks that had defaults now state them

`providerInfo` names the route `ChatGPT`; image projection, image pricing, and retry policy keep the base-class defaults deliberately, because the route forwards normalized images unchanged and owns no route-specific price or backoff. A `streamIdleTimeoutMs` config bounds a stalled stream, since the SDK timeout covers only the time to response headers.

## Alternatives considered

- **Ship as an experimental optional bundle.** Correct for an unproven capability, but the provider is a maintained product surface that users enable per account rather than per installation; an optional bundle would also make the base composition unaware of a provider the Models page lists.
- **Keep the external plugin's `modifyRecord` write.** It preserves the cancellation-before-lock guarantee without a seam change, but it needs a second committing latch and leaves the seam reporting `NOT_COMMITTED` for a successful sign-in.
- **Keep the self-mounted Remote contribution.** In-box specs refuse `$mount` by design, and the client would still need a nested plugin to sequence descriptor availability.
- **Reimplement the OpenAI Responses transport on raw fetch.** The SDK already carries the stream typing and error data the adapter maps; only the replay converter was internal.
- **Ship the OpenAI logo asset.** The mark is a third-party trademark and the in-box artwork rules require designer approval for any new glyph; the page is text-only.

## Consequences

- The external bundle must be removed from a profile before the in-box rows mount; two rows registering `chatgpt` fail loudly. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/chatgpt-provider-in-box/guide.md) owns the migration, and the retained credential scope and provider id keep saved accounts working.
- The replay validator stays in `responses.ts` beside the terminal-output validation it feeds, so one file owns every check on replayed items.
- The test suite ports the external plugin's OAuth, host, and adapter specs and adds a real Loader composition; the typert-generator patch and the bespoke client build are deleted rather than ported.
- Client-side Japanese copy lives in `@deepseek-ai/dsh-client-locale-ja`, matching every other namespace.
