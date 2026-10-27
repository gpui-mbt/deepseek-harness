# CI runner defaults

English | [中文](README.zh.md)

## Fork CI runners

This fork defaults the six static, coverage, snapshot/artifact, and native Windows lanes to standard GitHub-hosted `ubuntu-24.04` and `windows-2025` runners. Explicit failover variables retain their opt-in semantics; no repository settings or permissions are changed. Hosted gate concurrency is one, coverage uses two workers and two partitions, and snapshot workers are bounded at two. These are resource budgets, not test filters: all existing commands, platform matrices, coverage thresholds, snapshots, and final-verdict dependencies remain intact. Windows coverage remains an independent result, as in the inherited workflow. Hosted execution still needs actual CI confirmation; runner availability alone is not a pass.

The implementation is [ci.yml](ci.yml); runner resolution and required-gate retention are checked by [ci-hosted-runners.spec.ts](../../scripts/ci-hosted-runners.spec.ts).
