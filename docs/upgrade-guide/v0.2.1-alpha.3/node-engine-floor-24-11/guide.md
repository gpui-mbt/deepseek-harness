---
kind: upgrade-guide
description: "The repository's Node floor moves to 24.11 on the Node 24 line because the bundled toolchain cannot run on 24.0 through 24.10."
---

# Node 24 floor moves to 24.11

English | [中文](guide.zh.md)

## Change

The repository now runs its tests, lints, and builds on [Vite+](https://viteplus.dev/), whose bundled tooling requires Node `^22.18.0 || ^24.11.0 || >=26.0.0`. The root `package.json` engine range therefore moves from `^22.19.0 || >=24.0.0` to `^22.19.0 || ^24.11.0 || >=26.0.0`, and the CI compatibility matrix replaces its Node 24.9 leg — the release that still carried the v1 internal loader — with 24.11.

Published `@deepseek-ai/dsh-*` packages declare no `engines` field and ship no part of the toolchain, so installing and running them is unaffected. The floor binds contributors, CI, and anyone building this repository from source.

## Migration

1. Move any host that builds or tests this repository to Node 22.19+, 24.11+, or 26+. Node 24.10 and older still run released packages; they can no longer run this repository's toolchain.

```sh
node --version
pnpm install
```

2. If a host pins the old floor, replace it. Hosts that install only published packages need no change.

```sh
# before
"engines": { "node": "^22.19.0 || >=24.0.0" }
# after
"engines": { "node": "^22.19.0 || ^24.11.0 || >=26.0.0" }
```

3. On hosts that cannot move, stay on the previous release of this repository; its toolchain predates the floor.