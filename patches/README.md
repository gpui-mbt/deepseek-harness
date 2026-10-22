# esbuild Windows input transport

The esbuild patches keep large Windows transform inputs on the existing IPC path because restricted native children cannot delete input temporary files. macOS and Linux retain upstream file transport; target and minification options are unchanged. Native output-file handling is unchanged: Node reads and removes those files.

The pinned versions are 0.21.5 (VitePress/Vite 5), 0.25.12 (Web/Vite 6), and 0.28.1/0.28.2 (build tooling). Registry inspection on 2026-10-22 found 0.21.5 and 0.25.12 already at the top of their compatible minor ranges. The latest release, 0.28.2, retains the same input-file optimization, and the unpatched Windows-transport regression fails for all four versions.

Upstream implementation: [shared transform transport](https://github.com/evanw/esbuild/blob/v0.28.2/lib/shared/common.ts) and [Node filesystem transport](https://github.com/evanw/esbuild/blob/v0.28.2/lib/npm/node.ts). Re-evaluate each patch when its exact dependency version changes. IPC can increase Windows peak memory and transfer time for large inputs.

Run `pnpm install --frozen-lockfile` followed by `pnpm run test:esbuild-tempfile` to verify reinstallation. Tests cover string, byte-array and multibyte inputs, async and sync APIs, exact 1 MiB and either side, and larger inputs. Native probes use the host OS; simulated platform probes select the transport branch while retaining the host binary, and do not establish native Windows permission behavior. The dedicated CI workflow also runs native Windows, macOS and Linux builds and a development-server smoke.
