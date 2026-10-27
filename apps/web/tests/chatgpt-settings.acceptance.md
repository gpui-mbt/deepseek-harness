# ChatGPT settings browser acceptance

Run after building the workspace artifacts required by `test:web:built`:

```sh
pnpm exec vp test --config vitest.web.config.ts apps/web/tests/chatgpt-settings.e2e.ts
```

Install the pinned Playwright Chromium first if needed. In a restricted cloud
workspace, use a writable cache for both installation and execution:

```sh
cd apps/web
PLAYWRIGHT_BROWSERS_PATH=/tmp/dsh-playwright pnpm exec playwright install chromium
cd ../..
PLAYWRIGHT_BROWSERS_PATH=/tmp/dsh-playwright pnpm exec vp test --config vitest.web.config.ts apps/web/tests/chatgpt-settings.e2e.ts
```

The test runs Chromium against the shipped Web composition and real Host Remote,
Authorization, Credentials and Settings services, each under the scaffold's
isolated temporary home. It checks:

- Plugins → ChatGPT card and account page;
- real loopback callback creation, PKCE S256, fresh state and cancellation across
  repeated browser-popup flows;
- an explicitly fake preconnected account, catalog refresh, model context override
  saved to the real profile patch, and browser-reload persistence;
- welcome acknowledgement persistence;
- cancelled sign-out preserving credentials, then confirmed local sign-out removing
  access, refresh and ID tokens even when the mocked provider cannot confirm revocation.

Only the external OpenAI network boundary is mocked. No product authentication
endpoint is changed. Popup navigation is intercepted inside Chromium, and fake
catalog/revocation requests are intercepted inside the Host process. There is no
real provider login, real token, paid model request, or user credential access.

This is **not** coverage of successful OAuth callback/token exchange, live OpenAI
compatibility, Responses generation, or recorded-session snapshot replay. Those
need their separate protocol/replay tests and evidence. A browser dependency or
build failure means this acceptance is **NOT_RUN**, not a successful layout or
component test. Test failure screenshots use the existing `saveFailureShot` helper.

If the pinned Chromium download is unavailable, this one test also accepts
`DSH_WEB_E2E_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium`. Record that browser's
version alongside results; a system-browser run is not evidence for the pinned
Playwright browser version used by CI.

The hosted `ChatGPT keyless acceptance` workflow runs on `ubuntu-latest` without
repository secrets or enterprise runner labels. It uploads only bounded build/test
logs, a status JSON, and fixture-only screenshots. The browser test writes its
started marker **after** Host/browser setup succeeds; a missing marker is reported
as `NOT_RUN`, including browser-launch or setup failures. A successful test saves
`browser-settings.png`; that screenshot alone is not proof that every assertion
passed. Read the test exit status alongside it. Live OAuth, live Responses and
recorded-session snapshots remain explicitly `NOT_RUN` in this lane.
