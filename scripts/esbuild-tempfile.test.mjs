import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const installations = new Set(
  [
    ['../apps/web/package.json', 'vite'],
    ['../website/package.json', 'vite'],
    ['../package.json', 'vite'],
    ['../package.json', 'tsx'],
  ].map(([manifest, consumer]) => {
    const owner = createRequire(new URL(manifest, import.meta.url))
    const dependency = createRequire(owner.resolve(`${consumer}/package.json`))
    return dirname(dependency.resolve('esbuild/package.json'))
  }),
)
assert.equal(installations.size, 4, 'Review esbuild patches and consumers when the dependency graph changes')

for (const installation of installations) {
  for (const platform of ['native', 'win32', 'linux', 'darwin']) {
    test(`${installation}: ${platform} transforms around 1 MiB without changing output`, () => {
      const result = spawnSync(process.execPath, ['scripts/fixtures/esbuild-tempfile-probe.cjs', installation, platform], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
      })
      assert.ifError(result.error)
      assert.equal(result.signal, null, result.stderr)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /24 transforms passed/)
    })
  }
}
