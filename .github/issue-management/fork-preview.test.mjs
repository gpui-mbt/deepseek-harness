/** Keyless contract tests for the optional deployment boundary; no Cloudflare calls. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const source = readFileSync(new URL('../workflows/build-preview-cloudflare.yml', import.meta.url), 'utf8')
const boundary = source.split('      - name: Determine preview deployment availability\n')[1].split('      - name: Upload')[0]
const script = boundary.split('        run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
const keys = ['CF_PROJECT', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']

test('deployment availability handles every missing value without leaking values', {
  skip: process.platform === 'win32' ? 'The preview workflow executes under hosted Ubuntu bash' : false,
}, () => {
  for (const missing of [...keys, 'all', 'none', 'whitespace']) {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-preview-config-'))
    try {
      const env = { PATH: process.env.PATH, GITHUB_OUTPUT: join(directory, 'output'), GITHUB_STEP_SUMMARY: join(directory, 'summary') }
      for (const key of keys) env[key] = key === missing || missing === 'all' ? '' : 'synthetic-secret-never-log'
      if (missing === 'whitespace') env.CF_ACCESS_CLIENT_SECRET = ' \t '
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), `enabled=${missing === 'none'}\n`)
      if (missing !== 'none') {
        const summary = readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')
        assert.match(summary, /NOT_RUN/)
        assert.match(summary, /No deployment was performed/)
        assert.doesNotMatch(summary, /synthetic-secret-never-log/)
      }
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret-never-log/)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})

test('build and pack remain unconditional; all external deployment steps share the guard', () => {
  const before = source.split('      - name: Determine preview deployment availability')[0]
  assert.match(before, /run: pnpm run build:artifacts/)
  assert.match(before, /run: pnpm --filter @deepseek-ai\/dsh-web-frontend run build:preview/)
  assert.doesNotMatch(before, /\n        if:/)
  for (const name of ['Upload to Cloudflare Pages', 'Verify the protected deployment serves the image', 'Comment the preview URL']) {
    const step = source.split(`      - name: ${name}\n`)[1].split('      - name: ')[0]
    assert.match(step, /if: \$\{\{ steps\.deployment\.outputs\.enabled == 'true' \}\}/)
    assert.doesNotMatch(step, /continue-on-error|always\(\)/)
  }
  assert.match(source, /CF_PROJECT: \$\{\{ vars.CF_PROJECT \}\}/)
  assert.doesNotMatch(boundary, /node |pnpm |npx /)
  assert.match(source, /permissions:\n  contents: read\n  pull-requests: write/)
})
